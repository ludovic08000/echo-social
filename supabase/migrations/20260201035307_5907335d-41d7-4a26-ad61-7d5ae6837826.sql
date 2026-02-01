-- Enable realtime for posts table
ALTER PUBLICATION supabase_realtime ADD TABLE public.posts;

-- Enable realtime for likes table (for live reaction counts)
ALTER PUBLICATION supabase_realtime ADD TABLE public.likes;

-- Enable realtime for comments table (for live comment counts)
ALTER PUBLICATION supabase_realtime ADD TABLE public.comments;