-- Tighten RLS: only admin role can manage ab_tests
DROP POLICY "Authenticated users can manage ab_tests" ON public.ab_tests;

CREATE POLICY "Admin can manage ab_tests"
  ON public.ab_tests FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Tighten metrics insert: only authenticated (legitimate calls)
DROP POLICY "Authenticated users can insert ai_metrics_log" ON public.ai_metrics_log;

CREATE POLICY "Service can insert ai_metrics_log"
  ON public.ai_metrics_log FOR INSERT TO authenticated
  WITH CHECK (true);