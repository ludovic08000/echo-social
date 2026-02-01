import { Link } from 'react-router-dom';
import { FileText, Settings, Plus, ChevronRight, Building2 } from 'lucide-react';
import { useMyPages } from '@/hooks/usePages';
import { CreatePageDialog } from './CreatePageDialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

const CATEGORY_LABELS: Record<string, string> = {
  business: 'Entreprise',
  brand: 'Marque',
  artist: 'Artiste',
  community: 'Communauté',
  entertainment: 'Divertissement',
  sports: 'Sports',
  news: 'Actualités',
  education: 'Éducation',
  nonprofit: 'Association',
  general: 'Autre',
};

export function MyPagesList() {
  const { data: pages, isLoading } = useMyPages();

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3 p-4 rounded-xl bg-secondary/50">
            <Skeleton className="w-12 h-12 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Create button */}
      <CreatePageDialog>
        <Button className="w-full premium-button">
          <Plus className="w-4 h-4 mr-2" />
          Créer une page
        </Button>
      </CreatePageDialog>

      {/* Pages list */}
      {!pages || pages.length === 0 ? (
        <div className="text-center py-8">
          <FileText className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
          <p className="text-muted-foreground">
            Vous n'avez pas encore créé de page
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {pages.map((page) => (
            <div
              key={page.id}
              className="flex items-center gap-3 p-4 rounded-xl bg-secondary/50 hover:bg-secondary transition-colors cursor-pointer group"
            >
              {/* Page avatar */}
              <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center overflow-hidden">
                {page.profile_image_url ? (
                  <img
                    src={page.profile_image_url}
                    alt={page.name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <Building2 className="w-6 h-6 text-primary" />
                )}
              </div>

              {/* Page info */}
              <div className="flex-1 min-w-0">
                <h4 className="font-medium truncate">{page.name}</h4>
                <p className="text-sm text-muted-foreground">
                  {CATEGORY_LABELS[page.category] || page.category}
                  {page.follower_count !== undefined && ` • ${page.follower_count} abonnés`}
                </p>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <Settings className="w-4 h-4" />
                </Button>
                <ChevronRight className="w-5 h-5 text-muted-foreground" />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
