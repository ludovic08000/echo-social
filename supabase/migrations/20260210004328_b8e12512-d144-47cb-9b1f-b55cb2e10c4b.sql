
-- Create TV channels table
CREATE TABLE public.tv_channels (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  theme TEXT NOT NULL DEFAULT 'general',
  thumbnail_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  viewer_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.tv_channels ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "TV channels are viewable by everyone" ON public.tv_channels FOR SELECT USING (true);
CREATE POLICY "Users can create their own channels" ON public.tv_channels FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own channels" ON public.tv_channels FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete their own channels" ON public.tv_channels FOR DELETE USING (auth.uid() = user_id);

-- Trigger for updated_at
CREATE TRIGGER update_tv_channels_updated_at
BEFORE UPDATE ON public.tv_channels
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.tv_channels;
