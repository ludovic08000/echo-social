import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FeedIntelligenceSection } from '../FeedIntelligenceSection';
import { MLFeedSection } from '../MLFeedSection';
import { AISection } from '../AISection';
import { ZeusSection } from '../ZeusSection';

export function FeedIntelligenceMerged() {
  return (
    <Tabs defaultValue="algo" className="w-full">
      <TabsList className="bg-card/40 backdrop-blur-xl border border-border/40 rounded-full p-1 mb-4">
        <TabsTrigger value="algo" className="rounded-full data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">Algorithme</TabsTrigger>
        <TabsTrigger value="ml" className="rounded-full data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">ML Pipeline</TabsTrigger>
      </TabsList>
      <TabsContent value="algo"><FeedIntelligenceSection /></TabsContent>
      <TabsContent value="ml"><MLFeedSection /></TabsContent>
    </Tabs>
  );
}

export function AIMerged() {
  return (
    <Tabs defaultValue="engine" className="w-full">
      <TabsList className="bg-card/40 backdrop-blur-xl border border-border/40 rounded-full p-1 mb-4">
        <TabsTrigger value="engine" className="rounded-full data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">Moteur IA</TabsTrigger>
        <TabsTrigger value="zeus" className="rounded-full data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">Zeus</TabsTrigger>
      </TabsList>
      <TabsContent value="engine"><AISection /></TabsContent>
      <TabsContent value="zeus"><ZeusSection /></TabsContent>
    </Tabs>
  );
}
