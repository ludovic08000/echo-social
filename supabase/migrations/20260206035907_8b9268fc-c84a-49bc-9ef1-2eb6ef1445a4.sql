
-- Create albums table
CREATE TABLE public.albums (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  cover_url TEXT,
  privacy TEXT NOT NULL DEFAULT 'public',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create album_media table
CREATE TABLE public.album_media (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  album_id UUID NOT NULL REFERENCES public.albums(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  media_url TEXT NOT NULL,
  media_type TEXT NOT NULL DEFAULT 'image', -- 'image' or 'video'
  caption TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.albums ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.album_media ENABLE ROW LEVEL SECURITY;

-- Albums policies
CREATE POLICY "Albums are viewable by everyone"
  ON public.albums FOR SELECT USING (true);

CREATE POLICY "Users can create their own albums"
  ON public.albums FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own albums"
  ON public.albums FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own albums"
  ON public.albums FOR DELETE USING (auth.uid() = user_id);

-- Album media policies
CREATE POLICY "Album media is viewable by everyone"
  ON public.album_media FOR SELECT USING (true);

CREATE POLICY "Users can add media to their albums"
  ON public.album_media FOR INSERT
  WITH CHECK (auth.uid() = user_id AND EXISTS (
    SELECT 1 FROM public.albums WHERE id = album_id AND user_id = auth.uid()
  ));

CREATE POLICY "Users can delete their media"
  ON public.album_media FOR DELETE
  USING (auth.uid() = user_id);

-- Indexes
CREATE INDEX idx_albums_user_id ON public.albums(user_id);
CREATE INDEX idx_album_media_album_id ON public.album_media(album_id);
CREATE INDEX idx_album_media_user_id ON public.album_media(user_id);

-- Update trigger
CREATE TRIGGER update_albums_updated_at
  BEFORE UPDATE ON public.albums
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
