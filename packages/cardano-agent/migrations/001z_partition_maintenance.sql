CREATE OR REPLACE FUNCTION public.ensure_conversation_partitions(
  reference_at timestamptz DEFAULT pg_catalog.clock_timestamp()
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  month_start date;
  partition_start date;
  partition_end date;
  partition_name text;
  month_offset integer;
BEGIN
  IF reference_at IS NULL OR NOT pg_catalog.isfinite(reference_at) THEN
    RAISE EXCEPTION 'Partition date is invalid';
  END IF;

  month_start := pg_catalog.date_trunc('month', reference_at AT TIME ZONE 'UTC')::date;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vennek:conversation-message-partitions', 0)
  );

  FOR month_offset IN 0..2 LOOP
    partition_start := (
      month_start + pg_catalog.make_interval(months => month_offset)
    )::date;
    partition_end := (
      month_start + pg_catalog.make_interval(months => month_offset + 1)
    )::date;
    partition_name := pg_catalog.format(
      'conversation_messages_%s',
      pg_catalog.to_char(partition_start, 'YYYY_MM')
    );
    EXECUTE pg_catalog.format(
      'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.conversation_messages
       FOR VALUES FROM (TIMESTAMPTZ %L) TO (TIMESTAMPTZ %L)',
      partition_name,
      partition_start::text || ' 00:00:00+00',
      partition_end::text || ' 00:00:00+00'
    );
  END LOOP;
END
$function$;

REVOKE ALL ON FUNCTION public.ensure_conversation_partitions(timestamptz) FROM PUBLIC;
