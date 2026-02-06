import { useState } from 'react';
import { ArrowLeft, Plus, BookOpen, Trash2, Edit2, Smile } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useJournalEntries, useCreateJournalEntry, useUpdateJournalEntry, useDeleteJournalEntry, type JournalEntry } from '@/hooks/useJournal';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const MOOD_OPTIONS = ['😊', '😢', '😤', '😴', '🥰', '🤔', '😎', '🎉', '😰', '🙏'];

export default function Journal() {
  const navigate = useNavigate();
  const { data: entries, isLoading } = useJournalEntries();
  const createEntry = useCreateJournalEntry();
  const updateEntry = useUpdateJournalEntry();
  const deleteEntry = useDeleteJournalEntry();

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<JournalEntry | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [mood, setMood] = useState('');
  const [selectedEntry, setSelectedEntry] = useState<JournalEntry | null>(null);

  const openNew = () => {
    setEditingEntry(null);
    setTitle('');
    setBody('');
    setMood('');
    setIsDialogOpen(true);
  };

  const openEdit = (entry: JournalEntry) => {
    setEditingEntry(entry);
    setTitle(entry.title || '');
    setBody(entry.body);
    setMood(entry.mood || '');
    setIsDialogOpen(true);
  };

  const handleSave = async () => {
    if (!body.trim()) return;
    try {
      if (editingEntry) {
        await updateEntry.mutateAsync({ id: editingEntry.id, title, body, mood });
        toast({ title: 'Entrée modifiée !' });
      } else {
        await createEntry.mutateAsync({ title, body, mood });
        toast({ title: 'Entrée ajoutée !' });
      }
      setIsDialogOpen(false);
    } catch {
      toast({ title: 'Erreur', variant: 'destructive' });
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Supprimer cette entrée ?')) return;
    try {
      await deleteEntry.mutateAsync(id);
      setSelectedEntry(null);
      toast({ title: 'Entrée supprimée' });
    } catch {
      toast({ title: 'Erreur', variant: 'destructive' });
    }
  };

  return (
    <AppLayout>
      <div className="px-4 py-2">
        <header className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="h-8 w-8 rounded-full">
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <h1 className="text-lg font-bold">📔 Journal intime</h1>
          </div>
          <Button size="sm" className="premium-button h-9 text-xs" onClick={openNew}>
            <Plus className="w-4 h-4 mr-1" />
            Écrire
          </Button>
        </header>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="premium-card p-4 animate-pulse">
                <div className="h-4 w-1/3 bg-muted rounded" />
                <div className="h-3 w-2/3 bg-muted rounded mt-2" />
              </div>
            ))}
          </div>
        ) : entries?.length === 0 ? (
          <div className="premium-card p-10 text-center">
            <BookOpen className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">Votre journal est vide</p>
            <p className="text-xs text-muted-foreground/60 mt-1">Commencez à écrire vos pensées…</p>
            <Button size="sm" className="premium-button mt-4" onClick={openNew}>
              <Plus className="w-4 h-4 mr-1" /> Première entrée
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {entries?.map(entry => (
              <button
                key={entry.id}
                onClick={() => setSelectedEntry(entry)}
                className="w-full text-left premium-card p-4 hover:border-primary/20 transition-all"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {entry.mood && <span className="text-lg">{entry.mood}</span>}
                      <h3 className="text-sm font-semibold truncate">
                        {entry.title || new Date(entry.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}
                      </h3>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{entry.body}</p>
                  </div>
                  <span className="text-[10px] text-muted-foreground/60 ml-2 flex-shrink-0">
                    {new Date(entry.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Entry detail view */}
        <Dialog open={!!selectedEntry} onOpenChange={() => setSelectedEntry(null)}>
          <DialogContent className="max-w-md">
            {selectedEntry && (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    {selectedEntry.mood && <span>{selectedEntry.mood}</span>}
                    {selectedEntry.title || 'Sans titre'}
                  </DialogTitle>
                </DialogHeader>
                <p className="text-xs text-muted-foreground">
                  {new Date(selectedEntry.created_at).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </p>
                <p className="text-sm whitespace-pre-wrap leading-relaxed mt-2">{selectedEntry.body}</p>
                <div className="flex gap-2 mt-4">
                  <Button variant="outline" size="sm" onClick={() => { setSelectedEntry(null); openEdit(selectedEntry); }}>
                    <Edit2 className="w-3.5 h-3.5 mr-1" /> Modifier
                  </Button>
                  <Button variant="outline" size="sm" className="text-destructive" onClick={() => handleDelete(selectedEntry.id)}>
                    <Trash2 className="w-3.5 h-3.5 mr-1" /> Supprimer
                  </Button>
                </div>
              </>
            )}
          </DialogContent>
        </Dialog>

        {/* Create/edit dialog */}
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{editingEntry ? 'Modifier l\'entrée' : 'Nouvelle entrée'}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <Input
                placeholder="Titre (optionnel)"
                value={title}
                onChange={e => setTitle(e.target.value)}
                className="rounded-xl"
              />
              <Textarea
                placeholder="Écrivez vos pensées…"
                value={body}
                onChange={e => setBody(e.target.value)}
                className="rounded-xl min-h-[150px]"
                autoFocus
              />
              <div>
                <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
                  <Smile className="w-3.5 h-3.5" /> Humeur
                </p>
                <div className="flex gap-2 flex-wrap">
                  {MOOD_OPTIONS.map(m => (
                    <button
                      key={m}
                      onClick={() => setMood(mood === m ? '' : m)}
                      className={cn(
                        'w-9 h-9 rounded-full flex items-center justify-center text-lg transition-all',
                        mood === m ? 'bg-primary/15 ring-2 ring-primary scale-110' : 'hover:bg-secondary/60'
                      )}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
              <Button
                onClick={handleSave}
                disabled={!body.trim() || createEntry.isPending || updateEntry.isPending}
                className="premium-button w-full"
              >
                {(createEntry.isPending || updateEntry.isPending) ? 'Enregistrement…' : 'Enregistrer'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </AppLayout>
  );
}
