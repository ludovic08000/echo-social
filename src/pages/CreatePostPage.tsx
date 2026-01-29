import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { AppLayout } from '@/components/AppLayout';
import { CreatePost } from '@/components/CreatePost';
import { Button } from '@/components/ui/button';

export default function CreatePostPage() {
  const navigate = useNavigate();

  return (
    <AppLayout>
      <header className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h1 className="text-lg font-semibold">Nouveau post</h1>
      </header>

      <CreatePost />
    </AppLayout>
  );
}
