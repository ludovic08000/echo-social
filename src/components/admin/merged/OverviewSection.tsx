import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DashboardSection } from '../DashboardSection';
import { PlatformHealthDashboard } from '../PlatformHealthDashboard';
import { MonitoringSection } from '../MonitoringSection';

export function OverviewSection() {
  return (
    <Tabs defaultValue="dashboard" className="w-full">
      <TabsList className="bg-card/40 backdrop-blur-xl border border-border/40 rounded-full p-1 mb-4">
        <TabsTrigger value="dashboard" className="rounded-full data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">Tableau de bord</TabsTrigger>
        <TabsTrigger value="health" className="rounded-full data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">Santé</TabsTrigger>
        <TabsTrigger value="monitoring" className="rounded-full data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">Monitoring</TabsTrigger>
      </TabsList>
      <TabsContent value="dashboard"><DashboardSection /></TabsContent>
      <TabsContent value="health"><PlatformHealthDashboard /></TabsContent>
      <TabsContent value="monitoring"><MonitoringSection /></TabsContent>
    </Tabs>
  );
}
