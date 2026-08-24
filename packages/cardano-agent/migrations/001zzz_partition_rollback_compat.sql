-- One-release compatibility adapter for the previous runtime. The timestamp is
-- validated but intentionally ignored so the app cannot create arbitrary months.
CREATE OR REPLACE FUNCTION public.ensure_conversation_partitions(
  reference_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF reference_at IS NULL OR NOT pg_catalog.isfinite(reference_at) THEN
    RAISE EXCEPTION 'Partition date is invalid';
  END IF;
  PERFORM public.ensure_conversation_partitions();
END
$function$;

REVOKE ALL ON FUNCTION public.ensure_conversation_partitions(timestamptz) FROM PUBLIC;
