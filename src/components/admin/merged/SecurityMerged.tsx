import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SecurityMonitoringSection } from '../SecurityMonitoringSection';
import { SecuritySection } from '../SecuritySection';
import { CryptoErrorsSection } from '../CryptoErrorsSection';

export function SecurityMerged() {
  return (
    <Tabs defaultValue="soc" className="w-full">
      <TabsList className="bg-card/40 backdrop-blur-xl border border-border/40 rounded-full p-1 mb-4 flex-wrap h-auto">
        <TabsTrigger value="soc" className="rounded-full data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">SOC IA</TabsTrigger>
        <TabsTrigger value="abuse" className="rounded-full data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">Anti-abus</TabsTrigger>
        <TabsTrigger value="e2ee" className="rounded-full data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">E2EE</TabsTrigger>
      </TabsList>
      <TabsContent value="soc"><SecurityMonitoringSection /></TabsContent>
      <TabsContent value="abuse"><SecuritySection /></TabsContent>
      <TabsContent value="e2ee"><CryptoErrorsSection /></TabsContent>
    </Tabs>
  );
}
