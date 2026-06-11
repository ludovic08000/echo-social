
-- Fix overly permissive INSERT policy on ml_predictions
DROP POLICY "Service can insert predictions" ON public.ml_predictions;
CREATE POLICY "Auth users can have predictions" ON public.ml_predictions FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- Admin policies for full access
CREATE POLICY "Admins manage models" ON public.ml_models FOR ALL USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins see all predictions" ON public.ml_predictions FOR SELECT USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins see all fraud signals" ON public.ml_fraud_signals FOR SELECT USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins manage fraud signals" ON public.ml_fraud_signals FOR UPDATE USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Auth insert fraud signals" ON public.ml_fraud_signals FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Admins see all feedback" ON public.ml_training_feedback FOR SELECT USING (public.has_role(auth.uid(), 'admin'));
