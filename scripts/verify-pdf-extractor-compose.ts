import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const exec = promisify(execFile);
const composeFile = "docker-compose.yml";
const envFile = process.env.PDF_EXTRACTOR_ENV_FILE ?? ".env.example";
const project = `vennek-pdf-${process.pid}-${randomBytes(5).toString("hex")}`;
const token = process.env.PDF_EXTRACTOR_TOKEN ?? "A".repeat(43);

async function docker(args: string[], options: { allowFailure?: boolean; label?: string } = {}): Promise<string> {
  try {
    const result = await exec("docker", args, { maxBuffer: 16 * 1024 * 1024 });
    return result.stdout;
  } catch (error) {
    if (options.allowFailure) return `${error}`;
    const stderr = typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string"
      ? error.stderr.trim().slice(0, 2_000)
      : "";
    throw new Error(`docker command failed${options.label ? ` (${options.label})` : ""}${stderr ? `: ${stderr}` : ""}`);
  }
}

function compose(...args: string[]): string[] {
  return ["compose", "--project-name", project, "--env-file", envFile, "-f", composeFile, ...args];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const config = JSON.parse(await docker(compose("config", "--format", "json"))) as {
    services: Record<string, any>;
    networks: Record<string, { internal?: boolean }>;
  };
  const extractor = config.services["pdf-extractor"];
  const worker = config.services["agent-worker"];
  const image = extractor?.image as string;
  assert(extractor?.command?.join(" ") === "node packages/cardano-agent/dist/knowledge/pdfExtractorServer.js", "unexpected extractor command");
  assert(!extractor?.ports, "PDF extractor must not publish ports");
  assert(extractor?.networks?.["pdf-sandbox"] === null, "extractor must use pdf-sandbox");
  assert(config.networks["pdf-sandbox"]?.internal === true, "pdf-sandbox must be internal");
  assert(worker?.networks?.["pdf-sandbox"] === null && worker?.networks?.default === null, "worker network boundary changed");
  assert(extractor?.mem_limit === "268435456" && extractor?.memswap_limit === "268435456", "extractor memory limits changed");
  assert(extractor?.cpus === 0.5 && extractor?.pids_limit === 64, "extractor CPU/PID limits changed");
  assert(extractor?.read_only === true && extractor?.cap_drop?.includes("ALL"), "extractor isolation changed");

  try {
    await docker(compose("build", "migrate"), { label: "current image build" });
    const graphProbe = `
      const fs = require('node:fs');
      const path = require('node:path');
      const root = path.resolve('packages/cardano-agent/dist');
      const staticImport = /\\b(?:import|export)\\s+(?:[^"']+\\s+from\\s+)?["']([^"']+)["']/g;
      const resolveRelative = (from, specifier) => {
        const candidate = path.resolve(path.dirname(from), specifier);
        const options = path.extname(candidate) ? [candidate] : [candidate, candidate + '.js', path.join(candidate, 'index.js')];
        const resolved = options.find((file) => fs.existsSync(file));
        if (!resolved) throw new Error('missing compiled import ' + specifier + ' from ' + from);
        return resolved;
      };
      const assertGraph = (entry) => {
        const pending = [path.resolve(root, entry)];
        const seen = new Set();
        while (pending.length > 0) {
          const file = pending.pop();
          if (seen.has(file)) continue;
          seen.add(file);
          const source = fs.readFileSync(file, 'utf8');
          staticImport.lastIndex = 0;
          for (const match of source.matchAll(staticImport)) {
            const specifier = match[1];
            if (specifier.includes('pdfjs-dist') || specifier.includes('pdfExtractorWorker')) {
              throw new Error(entry + ' reaches forbidden import ' + specifier + ' from ' + file);
            }
            if (!specifier.startsWith('.')) continue;
            const resolved = resolveRelative(file, specifier);
            if (path.basename(resolved) === 'pdfExtractorWorker.js') {
              throw new Error(entry + ' reaches pdfExtractorWorker.js from ' + file);
            }
            pending.push(resolved);
          }
        }
      };
      assertGraph('index.js');
      assertGraph('knowledge/pdfExtractorServer.js');
      const workerSource = fs.readFileSync(path.join(root, 'knowledge/pdfExtractorWorker.js'), 'utf8');
      if (!/\\bimport\\s+(?:[^"']+\\s+from\\s+)?["']pdfjs-dist\\//.test(workerSource)) {
        throw new Error('compiled worker does not statically import pdfjs-dist');
      }
      console.log('compiled import graph ok');
    `;
    await docker(["run", "--rm", image, "node", "--input-type=commonjs", "-e", graphProbe], { label: "compiled import reachability" });
    await docker(compose("up", "-d", "--wait", "--no-build", "pdf-extractor"));
    const container = `${project}-pdf-extractor-1`;
    const inspect = JSON.parse(await docker(["inspect", container]))[0] as { Config: any; HostConfig: any; NetworkSettings: any };
    assert(inspect.HostConfig.Memory === 268435456, "effective memory limit changed");
    assert(inspect.HostConfig.MemorySwap === 268435456, "effective memory swap limit changed");
    assert(inspect.HostConfig.NanoCpus === 500000000, "effective CPU limit changed");
    assert(inspect.HostConfig.ReadonlyRootfs === true, "effective read-only rootfs changed");
    assert(inspect.HostConfig.PidsLimit === 64, "effective PID limit changed");
    assert(inspect.HostConfig.CapDrop?.includes("ALL"), "effective capability drop changed");
    assert(inspect.HostConfig.SecurityOpt?.some((value: unknown) => value === "no-new-privileges:true" || value === "no-new-privileges"), "effective no-new-privileges changed");
    assert(inspect.Config?.User === "1000:1000", "effective user changed");
    assert(inspect.HostConfig.Init === true, "effective init changed");
    const tmpfs = inspect.HostConfig.Tmpfs?.["/tmp"];
    assert(typeof tmpfs === "string" && ["size=16m", "uid=1000", "gid=1000", "noexec", "nosuid", "nodev"].every((value) => tmpfs.includes(value)) && (tmpfs.includes("mode=0700") || tmpfs.includes("mode=700")), "effective /tmp isolation changed");
    assert(Object.values(inspect.NetworkSettings.Ports ?? {}).every((value) => value === null), "extractor unexpectedly has published ports");

    const network = `${project}_pdf-sandbox`;
    const nodeScript = `
      const http = require('node:http');
      const token = process.env.PDF_EXTRACTOR_TOKEN;
      const request = (body, auth = token, declaredLength = body.length, timeoutMs = 30000) => new Promise((resolve) => {
        const req = http.request({ host: 'pdf-extractor', port: 8081, path: '/v1/extract/pdf', method: 'POST', headers: { authorization: 'Bearer ' + auth, 'content-type': 'application/pdf', 'content-length': declaredLength } }, (res) => { let data = ''; res.on('data', (chunk) => data += chunk); res.on('end', () => resolve({ status: res.statusCode, data })); });
        req.setTimeout(timeoutMs, () => req.destroy(new Error('request timeout')));
        req.on('error', (error) => resolve({ status: 0, data: String(error.message || error) })); req.end(body);
      });
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 250)));
      const healthRequest = () => new Promise((resolve) => {
        const req = http.request({ host: 'pdf-extractor', port: 8081, path: '/health', method: 'GET' }, (res) => { let data = ''; res.on('data', (chunk) => data += chunk); res.on('end', () => resolve({ status: res.statusCode, data })); });
        req.setTimeout(2000, () => req.destroy(new Error('health timeout')));
        req.on('error', (error) => resolve({ status: 0, data: String(error.message || error) })); req.end();
      });
      const pollHealth = async (label) => {
        const deadline = Date.now() + 30000; let last = { status: 0, data: 'not attempted' };
        while (Date.now() <= deadline) {
          last = await healthRequest();
          if (last.status === 200) return;
          await sleep(250);
        }
        throw new Error(label + ' health timeout: last status ' + last.status + ' error ' + last.data);
      };
      const pollMalformed = async (label) => {
        const deadline = Date.now() + 30000; let last = { status: 0, data: 'not attempted' };
        while (Date.now() <= deadline) {
          last = await request(Buffer.from('not a pdf'), token, Buffer.byteLength('not a pdf'), 2000);
          if ([422, 503].includes(last.status)) return;
          await sleep(250);
        }
        throw new Error(label + ' malformed timeout: last status ' + last.status + ' error ' + last.data);
      };
      const validPdf = Buffer.from('JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggMzcgPj4Kc3RyZWFtCkJUIC9GMSAxOCBUZiA3MiA3MjAgVGQgKENhcmRhbm8gd29ya3MpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDMxMSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQwNQolJUVPRgo=', 'base64');
      const pollValidExtraction = async (label) => {
        const deadline = Date.now() + 30000; let last = { status: 0, data: 'not attempted' };
        while (Date.now() <= deadline) {
          last = await request(validPdf, token, validPdf.length, 5000);
          if (last.status === 200) {
            try {
              if (JSON.parse(last.data).text?.includes('Cardano works')) return;
              last = { status: last.status, data: 'response text did not contain Cardano works' };
            } catch (error) {
              last = { status: last.status, data: 'invalid JSON: ' + String(error?.message || error) };
            }
          }
          await sleep(250);
        }
        throw new Error(label + ' valid extraction timeout: last status ' + last.status + ' error ' + last.data);
      };
      const makeStressPdf = () => {
        const zlib = require('node:zlib');
        const compressed = zlib.deflateSync(Buffer.from('BT (' + 'A'.repeat(20000000) + ') Tj ET'));
        const objects = [
          Buffer.from('1 0 obj\\n<< /Type /Catalog /Pages 2 0 R >>\\nendobj\\n'),
          Buffer.from('2 0 obj\\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\\nendobj\\n'),
          Buffer.from('3 0 obj\\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\\nendobj\\n'),
          Buffer.concat([Buffer.from('4 0 obj\\n<< /Length ' + compressed.length + ' /Filter /FlateDecode >>\\nstream\\n'), compressed, Buffer.from('\\nendstream\\nendobj\\n')]),
        ];
        const pieces = [Buffer.from('%PDF-1.4\\n')];
        const offsets = [0];
        let size = pieces[0].length;
        for (const object of objects) { offsets.push(size); pieces.push(object); size += object.length; }
        const xref = size;
        let table = 'xref\\n0 5\\n0000000000 65535 f \\n';
        table += offsets.slice(1).map((offset) => String(offset).padStart(10, '0') + ' 00000 n \\n').join('');
        pieces.push(Buffer.from(table + 'trailer\\n<< /Size 5 /Root 1 0 R >>\\nstartxref\\n' + xref + '\\n%%EOF\\n'));
        return Buffer.concat(pieces);
      };
      (async () => {
        const invalid = await request(Buffer.from('%PDF-1.4'), 'bad');
        if (invalid.status !== 401) { console.error('invalid token status', invalid.status); process.exit(2); }
        const large = await request(Buffer.alloc(0), token, 8 * 1024 * 1024 + 1);
        if (large.status !== 413) { console.error('oversize status', large.status); process.exit(3); }
        const valid = await request(validPdf);
        if (valid.status !== 200 || !JSON.parse(valid.data).text.includes('Cardano works')) { console.error('valid extraction status', valid.status); process.exit(4); }
        const malformed = await request(Buffer.from('not a pdf'));
        if (![422, 503].includes(malformed.status)) { console.error('malformed PDF status', malformed.status); process.exit(5); }
        const stress = await request(makeStressPdf());
        if (![0, 422, 503, 504].includes(stress.status)) { console.error('stress PDF status', stress.status); process.exit(6); }
        await pollHealth('post-stress');
        await pollMalformed('post-stress');
        await pollValidExtraction('post-stress');
        await new Promise((resolve) => {
          const req = http.request({ host: 'pdf-extractor', port: 8081, path: '/v1/extract/pdf', method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/pdf', 'content-length': validPdf.length } });
          req.on('error', resolve); req.end(validPdf); req.destroy();
        });
        await pollHealth('post-abort');
        await pollMalformed('post-abort');
        await pollValidExtraction('post-abort');
        const outbound = await fetch('https://example.com').then(() => true, () => false);
        if (outbound) { console.error('outbound HTTPS unexpectedly succeeded'); process.exit(7); }
      })().catch((error) => { console.error('service probe error', error?.message || error); process.exit(10); });
    `;
    await docker(["run", "--rm", "--network", network, "-e", `PDF_EXTRACTOR_TOKEN=${token}`, image, "node", "-e", nodeScript], { label: "service checks" });
    const agentProbe = "import { PdfExtractorClient } from '@vennek/cardano-agent'; const client = new PdfExtractorClient({ url: process.env.PDF_EXTRACTOR_URL, token: process.env.PDF_EXTRACTOR_TOKEN }); const result = await client.extract(Buffer.from('JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggMzcgPj4Kc3RyZWFtCkJUIC9GMSAxOCBUZiA3MiA3MjAgVGQgKENhcmRhbm8gd29ya3MpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDI0MSAwMDAwMDAgbiAKMDAwMDAwMDMxMSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQwNQolJUVPRgo=', 'base64')); if (!result.text.includes('Cardano works')) process.exit(1);";
    await docker(compose("run", "--rm", "--no-deps", "agent-worker", "node", "-e", agentProbe), { label: "configured agent-to-service probe" });
    console.log(`PDF extractor Compose verification passed (${project})`);
  } finally {
    await docker(compose("down", "--volumes", "--remove-orphans"), { allowFailure: true });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "PDF extractor Compose verification failed");
  process.exitCode = 1;
});
