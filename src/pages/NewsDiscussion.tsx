import { Link, useParams } from 'react-router-dom';
import { AppLayout } from '@/components/AppLayout';
import { NewsDiscussionPanel } from '@/components/feed/NewsDiscussionPanel';

export default function NewsDiscussion() {
  const { id = '' } = useParams<{ id: string }>();
  return <AppLayout><div className="max-w-3xl mx-auto">
    <Link to="/feed" className="inline-block p-4 underline">Retour au feed</Link>
    <NewsDiscussionPanel threadId={id} />
  </div></AppLayout>;
}
