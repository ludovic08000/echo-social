
-- Force PostgREST schema cache reload by touching the table
COMMENT ON TABLE public.active_calls IS 'Call signaling table';

-- Ensure proper grants for authenticated and anon roles
GRANT SELECT, INSERT, UPDATE ON public.active_calls TO authenticated;
GRANT SELECT ON public.active_calls TO anon;

-- Re-enable realtime
ALTER TABLE public.active_calls REPLICA IDENTITY FULL;

-- Notify PostgREST
NOTIFY pgrst, 'reload schema';
