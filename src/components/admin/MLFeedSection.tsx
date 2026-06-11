import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { Brain, Play, RefreshCw, TrendingUp, Users, FileText, Zap } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { fr } from "date-fns/locale";

interface ModelRun {
  id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  users_processed: number | null;
  posts_processed: number | null;
  interactions_analyzed: number | null;
  metrics: any;
  error_message: string | null;
}

interface HybridWeights {
  collaborative: number;
  content: number;
  temporal: number;
  quality: number;
}

export function MLFeedSection() {
  const [runs, setRuns] = useState<ModelRun[]>([]);
  const [weights, setWeights] = useState<HybridWeights>({
    collaborative: 0.4,
    content: 0.4,
    temporal: 0.1,
    quality: 0.1,
  });
  const [stats, setStats] = useState({
    profiles: 0,
    features: 0,
    interactions24h: 0,
    avgCTR: 0,
  });
  const [loading, setLoading] = useState(false);
  const [training, setTraining] = useState(false);
  const [trainingTwoTower, setTrainingTwoTower] = useState(false);

  const load = async () => {
    setLoading(true);
    const [runsRes, configRes, profilesRes, featuresRes, interRes] = await Promise.all([
      supabase.from("ml_model_runs").select("*").order("started_at", { ascending: false }).limit(15),
      supabase.from("ml_model_config").select("value").eq("key", "hybrid_weights").maybeSingle(),
      supabase.from("ml_user_profiles").select("user_id", { count: "exact", head: true }),
      supabase.from("ml_post_features").select("post_id", { count: "exact", head: true }),
      supabase
        .from("ml_interactions")
        .select("id", { count: "exact", head: true })
        .gte("created_at", new Date(Date.now() - 86400000).toISOString()),
    ]);

    if (runsRes.data) setRuns(runsRes.data as unknown as ModelRun[]);
    if (configRes.data?.value) setWeights(configRes.data.value as unknown as HybridWeights);

    const lastSuccess = (runsRes.data || []).find((r: any) => r.status === "success") as any;
    const ctr = lastSuccess?.metrics && typeof lastSuccess.metrics === "object" && "global_ctr" in lastSuccess.metrics
      ? Number(lastSuccess.metrics.global_ctr) || 0
      : 0;
    setStats({
      profiles: profilesRes.count || 0,
      features: featuresRes.count || 0,
      interactions24h: interRes.count || 0,
      avgCTR: ctr,
    });
    setLoading(false);
  };

  useEffect(() => {
    load();
    const channel = supabase
      .channel("ml-runs")
      .on("postgres_changes", { event: "*", schema: "public", table: "ml_model_runs" }, () => load())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const triggerTraining = async () => {
    setTraining(true);
    try {
      const { error } = await supabase.functions.invoke("ml-feed-train");
      if (error) throw error;
      toast.success("Entraînement lancé");
      setTimeout(load, 2000);
    } catch (e: any) {
      toast.error("Échec : " + (e?.message || "erreur inconnue"));
    } finally {
      setTraining(false);
    }
  };

  const triggerTwoTower = async () => {
    setTrainingTwoTower(true);
    try {
      const { error } = await supabase.functions.invoke("ml-twotower-train");
      if (error) throw error;
      toast.success("Two-Tower : entraînement neural lancé (≈ 2-5 min)");
      setTimeout(load, 3000);
    } catch (e: any) {
      toast.error("Échec Two-Tower : " + (e?.message || "erreur inconnue"));
    } finally {
      setTrainingTwoTower(false);
    }
  };

  const updateWeight = (key: keyof HybridWeights, value: number) => {
    setWeights((w) => ({ ...w, [key]: value }));
  };

  const saveWeights = async () => {
    const sum = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
    const normalized = {
      collaborative: +(weights.collaborative / sum).toFixed(3),
      content: +(weights.content / sum).toFixed(3),
      temporal: +(weights.temporal / sum).toFixed(3),
      quality: +(weights.quality / sum).toFixed(3),
    };
    const { error } = await supabase
      .from("ml_model_config")
      .update({ value: normalized as any, updated_at: new Date().toISOString() })
      .eq("key", "hybrid_weights");
    if (error) {
      toast.error("Sauvegarde échouée");
    } else {
      toast.success("Poids mis à jour");
      setWeights(normalized);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <Brain className="h-6 w-6 text-primary" />
            Machine Learning Feed
          </h2>
          <p className="text-sm text-muted-foreground">
            Moteur hybride auto-apprenant (collaboratif + contenu + temporel)
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <Button size="sm" onClick={triggerTraining} disabled={training}>
            <Play className="h-4 w-4 mr-2" />
            {training ? "Entraînement..." : "Entraîner (classique)"}
          </Button>
          <Button size="sm" variant="secondary" onClick={triggerTwoTower} disabled={trainingTwoTower}>
            <Brain className="h-4 w-4 mr-2" />
            {trainingTwoTower ? "Neural..." : "Entraîner Two-Tower"}
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <Users className="h-8 w-8 text-blue-500" />
              <div>
                <div className="text-2xl font-bold">{stats.profiles}</div>
                <div className="text-xs text-muted-foreground">Profils ML</div>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <FileText className="h-8 w-8 text-purple-500" />
              <div>
                <div className="text-2xl font-bold">{stats.features}</div>
                <div className="text-xs text-muted-foreground">Posts analysés</div>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <Zap className="h-8 w-8 text-amber-500" />
              <div>
                <div className="text-2xl font-bold">{stats.interactions24h}</div>
                <div className="text-xs text-muted-foreground">Signaux 24h</div>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <TrendingUp className="h-8 w-8 text-green-500" />
              <div>
                <div className="text-2xl font-bold">{(stats.avgCTR * 100).toFixed(1)}%</div>
                <div className="text-xs text-muted-foreground">CTR global</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Weights tuning */}
      <Card>
        <CardHeader>
          <CardTitle>Poids du modèle hybride</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {(Object.keys(weights) as Array<keyof HybridWeights>).map((key) => (
            <div key={key} className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="capitalize">
                  {key === "collaborative" && "🤝 Collaboratif (auteurs préférés)"}
                  {key === "content" && "📝 Contenu (sujets/hashtags)"}
                  {key === "temporal" && "⏰ Temporel (heure d'activité)"}
                  {key === "quality" && "⭐ Qualité (CTR, engagement)"}
                </span>
                <Badge variant="secondary">{(weights[key] * 100).toFixed(0)}%</Badge>
              </div>
              <Slider
                value={[weights[key] * 100]}
                onValueChange={(v) => updateWeight(key, v[0] / 100)}
                max={100}
                step={5}
              />
            </div>
          ))}
          <Button onClick={saveWeights} className="w-full">
            Sauvegarder les poids
          </Button>
        </CardContent>
      </Card>

      {/* Runs history */}
      <Card>
        <CardHeader>
          <CardTitle>Historique des entraînements</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 max-h-96 overflow-auto">
            {runs.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-8">
                Aucun entraînement encore. Lance le premier !
              </p>
            )}
            {runs.map((run) => (
              <div
                key={run.id}
                className="flex items-center justify-between p-3 rounded-lg border bg-card"
              >
                <div className="flex items-center gap-3">
                  <Badge
                    variant={
                      run.status === "success"
                        ? "default"
                        : run.status === "failed"
                        ? "destructive"
                        : "secondary"
                    }
                  >
                    {run.status}
                  </Badge>
                  <div>
                    <div className="text-sm font-medium">
                      {format(new Date(run.started_at), "dd MMM HH:mm", { locale: fr })}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {run.users_processed || 0} users · {run.posts_processed || 0} posts ·{" "}
                      {run.interactions_analyzed || 0} signaux
                      {run.duration_ms && ` · ${(run.duration_ms / 1000).toFixed(1)}s`}
                    </div>
                  </div>
                </div>
                {run.metrics?.global_ctr !== undefined && (
                  <Badge variant="outline">CTR {(run.metrics.global_ctr * 100).toFixed(1)}%</Badge>
                )}
                {run.error_message && (
                  <span className="text-xs text-destructive truncate max-w-[200px]">
                    {run.error_message}
                  </span>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
