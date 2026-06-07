import { AppLayout } from '@/components/AppLayout';
import { QualityMetricsSection } from '@/components/admin/QualityMetricsSection';
import { useRequireAuth } from '@/hooks/useRequireAuth';

export default function CreatorQuality() {
  const ready = useRequireAuth();
  if (!ready) return null;
  return (
    <AppLayout>
      <div className="max-w-6xl mx-auto px-4 py-6">
        <QualityMetricsSection />
      </div>
    </AppLayout>
  );
}
