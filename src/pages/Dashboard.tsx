import { useMemo } from 'react';
import { AppLayout } from '@/components/AppLayout';
import { useAuth } from '@/lib/auth';
import { useProfile } from '@/hooks/useProfile';
import { usePosts } from '@/hooks/usePosts';
import { UserAvatar } from '@/components/UserAvatar';
import { useFriendships } from '@/hooks/useFriendships';
import { Card } from '@/components/ui/card';
import { Eye, MessageCircle, Users, TrendingUp, TrendingDown, BarChart3, Heart, Share2 } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { motion } from 'framer-motion';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';
import { Link } from 'react-router-dom';

function StatCard({ icon: Icon, label, value, change, changeLabel }: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  change?: number;
  changeLabel?: string;
}) {
  const isPositive = (change ?? 0) >= 0;
  return (
    <Card className="p-5 space-y-2 bg-card border-border/30">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="w-4 h-4" />
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <div className="flex items-end gap-3">
        <span className="text-2xl font-bold text-foreground">{value}</span>
        {change !== undefined && (
          <span className={`flex items-center gap-0.5 text-xs font-semibold ${isPositive ? 'text-emerald-500' : 'text-red-400'}`}>
            {isPositive ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
            {isPositive ? '+' : ''}{change}%
          </span>
        )}
      </div>
      {changeLabel && <p className="text-[11px] text-muted-foreground">{changeLabel}</p>}
    </Card>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const { data: profile } = useProfile();
  const { data: postsData } = usePosts();
  const { data: friendships } = useFriendships();

  const posts = useMemo(() => postsData?.pages.flat() || [], [postsData?.pages]);
  const myPosts = useMemo(() => posts.filter(p => p.user_id === user?.id), [posts, user?.id]);

  const totalViews = myPosts.reduce((s, p) => s + (p.views_count || 0), 0);
  const totalLikes = myPosts.reduce((s, p) => s + (p.likes_count || 0), 0);
  const totalComments = myPosts.reduce((s, p) => s + (p.comments_count || 0), 0);
  const friendCount = friendships?.friends.length || 0;

  // Mock chart data based on last 28 days
  const chartData = useMemo(() => {
    const days = [];
    const now = new Date();
    for (let i = 27; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dayLabel = `${d.getDate()}/${d.getMonth() + 1}`;
      // Simulate engagement curve
      const base = Math.max(totalViews / 28, 5);
      const variance = Math.random() * base * 1.5;
      days.push({
        date: dayLabel,
        vues: Math.round(base + variance),
        interactions: Math.round((base + variance) * 0.3),
      });
    }
    return days;
  }, [totalViews]);

  return (
    <AppLayout>
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center justify-between"
        >
          <div>
            <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-primary" />
              Statistiques
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Découvrez la performance de votre profil.
            </p>
          </div>
          <span className="text-xs text-muted-foreground bg-secondary/60 px-3 py-1.5 rounded-full">
            28 derniers jours
          </span>
        </motion.div>

        {/* Stats cards */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="grid grid-cols-2 md:grid-cols-4 gap-3"
        >
          <StatCard icon={Eye} label="Vues" value={totalViews.toLocaleString()} change={67} changeLabel="28 derniers jours" />
          <StatCard icon={Heart} label="Interactions" value={totalLikes + totalComments} change={132} changeLabel="Likes + commentaires" />
          <StatCard icon={Users} label="Amis" value={friendCount} change={-5} changeLabel="Followers nets" />
          <StatCard icon={Share2} label="Publications" value={myPosts.length} changeLabel="Total de posts" />
        </motion.div>

        {/* Chart */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <Card className="p-5 bg-card border-border/30">
            <h2 className="text-sm font-semibold text-foreground mb-4">Activité sur 28 jours</h2>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="colorVues" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="colorInter" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--accent-foreground))" stopOpacity={0.2} />
                      <stop offset="95%" stopColor="hsl(var(--accent-foreground))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} width={40} />
                  <Tooltip
                    contentStyle={{
                      background: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '12px',
                      fontSize: '12px',
                    }}
                  />
                  <Area type="monotone" dataKey="vues" stroke="hsl(var(--primary))" fillOpacity={1} fill="url(#colorVues)" strokeWidth={2} />
                  <Area type="monotone" dataKey="interactions" stroke="hsl(var(--accent-foreground))" fillOpacity={1} fill="url(#colorInter)" strokeWidth={1.5} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </motion.div>

        {/* Profile status + tools */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="grid md:grid-cols-2 gap-4"
        >
          {/* Profile status */}
          <Card className="p-5 bg-card border-border/30 space-y-4">
            <h3 className="text-sm font-semibold text-foreground">Statut du profil</h3>
            <div className="flex items-center gap-3">
              <UserAvatar src={profile?.avatar_url} alt={profile?.name} size="md" />
              <div>
                <p className="text-sm font-medium text-foreground">{profile?.name || 'Utilisateur'}</p>
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />
                  Le profil ne rencontre aucun problème.
                </p>
              </div>
            </div>
          </Card>

          {/* Content overview */}
          <Card className="p-5 bg-card border-border/30 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">Contenu</h3>
              <Link to="/feed" className="text-xs text-primary hover:underline">Voir tout</Link>
            </div>
            {myPosts.length > 0 ? (
              <div className="space-y-2">
                {myPosts.slice(0, 3).map(post => (
                  <Link key={post.id} to={`/post/${post.id}`} className="flex items-center justify-between p-2 rounded-lg hover:bg-secondary/40 transition-colors">
                    <p className="text-xs text-foreground truncate flex-1 mr-3">
                      {post.body?.slice(0, 60) || 'Publication'}
                    </p>
                    <div className="flex items-center gap-3 text-[11px] text-muted-foreground flex-shrink-0">
                      <span className="flex items-center gap-1"><Eye className="w-3 h-3" />{post.views_count || 0}</span>
                      <span className="flex items-center gap-1"><Heart className="w-3 h-3" />{post.likes_count || 0}</span>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Aucune publication encore.</p>
            )}
          </Card>
        </motion.div>
      </div>
    </AppLayout>
  );
}
