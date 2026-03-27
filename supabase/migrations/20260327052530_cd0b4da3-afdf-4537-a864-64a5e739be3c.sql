
-- Admin policies for managing users, posts, and reports

-- Admin can update any profile
CREATE POLICY "Admins can update profiles"
ON public.profiles FOR UPDATE
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Admin can delete any post
CREATE POLICY "Admins can delete posts"
ON public.posts FOR DELETE
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- Admin can update any post
CREATE POLICY "Admins can update posts"
ON public.posts FOR UPDATE
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Admin can view all abuse reports
CREATE POLICY "Admins can view all reports"
ON public.abuse_reports FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- Admin can update abuse reports
CREATE POLICY "Admins can update reports"
ON public.abuse_reports FOR UPDATE
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Admin can delete abuse reports (for dismissing)
CREATE POLICY "Admins can delete reports"
ON public.abuse_reports FOR DELETE
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));
