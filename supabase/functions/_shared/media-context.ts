import { FRENCH_REGIONS } from './rss-catalog.ts';
import type { Commune } from './communes.ts';

type Preferences = { local_media: boolean; country: string | null; region: string | null; city: string | null };
export type MediaContext = { country: string; region: string; city: string | null; source: 'selected' | 'profile' | 'network' };
const ISO_REGIONS: Record<string, keyof typeof FRENCH_REGIONS> = {
 ARA:'84',BFC:'27',BRE:'53',CVL:'24',COR:'94',GES:'44',HDF:'32',IDF:'11',NOR:'28',NAQ:'75',OCC:'76',PDL:'52',PAC:'93',
 GP:'01',MQ:'02',GF:'03',RE:'04',YT:'06',
};
const placeKey = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
/** Same canonical region names for gateway headers, IP providers and the French media catalogue. */
export function frenchRegion(country: string, value: unknown): string | null {
 if (['GP','MQ','GF','RE','YT'].includes(country)) return FRENCH_REGIONS[ISO_REGIONS[country]];
 if (country !== 'FR' || typeof value !== 'string' || value.length > 100) return null;
 const raw = value.trim().toUpperCase().replace(/^FR-/, '');
 const code = ISO_REGIONS[raw] ?? (Object.prototype.hasOwnProperty.call(FRENCH_REGIONS, raw) ? raw as keyof typeof FRENCH_REGIONS : null);
 if (code) return FRENCH_REGIONS[code];
 return Object.values(FRENCH_REGIONS).find(name => placeKey(name) === placeKey(value)) ?? null;
}
export function trustedRegion(headers: Headers, config: { enabled: boolean; countryHeader?: string; regionHeader?: string }): MediaContext | null {
 // Operator must verify that the gateway OVERWRITES both headers. No browser/IPinfo request here.
 if (!config.enabled || !config.countryHeader || !config.regionHeader) return null;
 const country=headers.get(config.countryHeader)?.trim().toUpperCase();
 const region=frenchRegion(country ?? '', headers.get(config.regionHeader));
 return region ? {country:'FR',region,city:null,source:'network'} : null;
}
export async function resolveMediaContext(input: {
 enabled: boolean; preferences: Preferences | null; profileCity: string | null;
 search: (query:string)=>Promise<Commune[]>; network: ()=>MediaContext | null | Promise<MediaContext | null>;
}): Promise<MediaContext | null> {
 if (!input.enabled || input.preferences?.local_media===false) return null;
 const p=input.preferences;
 if (p?.country && p.region) return {country:p.country,region:p.region,city:p.city,source:'selected'};
 const city=input.profileCity?.trim();
 if (city && city.length>=2 && city.length<=100) {
   try {
     const choices=await input.search(city);
     const exact=choices.filter(c=>placeKey(c.city)===placeKey(city));
     // Never pick the first homonymous town. A manual selection resolves ambiguity.
     if (exact.length===1) return {country:exact[0].country,region:exact[0].region,city:exact[0].city,source:'profile'};
   } catch { /* National/network fallback keeps the feed usable. */ }
 }
 return input.network();
}
