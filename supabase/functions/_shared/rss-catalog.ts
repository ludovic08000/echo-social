// Closed destinations, checked against public publisher feeds through 2026-10-08.
// A working RSS feed is NOT a publishing agreement. Each edition needs its own
// matching, active media_partners record before any ingestion/publication.
export const FRENCH_REGIONS = {
  '01': 'Guadeloupe', '02': 'Martinique', '03': 'Guyane', '04': 'La Réunion', '06': 'Mayotte',
  '11': 'Île-de-France', '24': 'Centre-Val de Loire', '27': 'Bourgogne-Franche-Comté',
  '28': 'Normandie', '32': 'Hauts-de-France', '44': 'Grand Est', '52': 'Pays de la Loire',
  '53': 'Bretagne', '75': 'Nouvelle-Aquitaine', '76': 'Occitanie',
  '84': 'Auvergne-Rhône-Alpes', '93': 'Provence-Alpes-Côte d’Azur', '94': 'Corse',
} as const;
export type RssEditorialCategory = 'general' | 'science' | 'music' | 'education' | 'wellbeing' | 'sport';
export interface RssCatalogEntry {
  name: string; url: string | null; websiteHost: string | null; verified: boolean;
  reference: string; regionCode: keyof typeof FRENCH_REGIONS | null; city: string | null;
  editorialCategory?: RssEditorialCategory;
}
function actu(slug: string, regionCode: keyof typeof FRENCH_REGIONS): RssCatalogEntry {
  const url = `https://actu.fr/${slug}/rss.xml`;
  return { name: `actu.fr — ${FRENCH_REGIONS[regionCode]}`, url, websiteHost: 'actu.fr',
    verified: true, reference: url, regionCode, city: null };
}
function publisher(
  name: string,
  url: string,
  regionCode: keyof typeof FRENCH_REGIONS | null = null,
  editorialCategory: RssEditorialCategory = 'general',
): RssCatalogEntry {
  return { name, url, websiteHost: new URL(url).hostname, verified: true, reference: url, regionCode, city: null, editorialCategory };
}
function pending(name: string, website: string, regionCode: keyof typeof FRENCH_REGIONS | null = null): RssCatalogEntry {
  return { name, url: null, websiteHost: new URL(website).hostname, verified: false, reference: website, regionCode, city: null };
}
export const RSS_CATALOG: Record<string, RssCatalogEntry> = {
  // Listed for follow-up, NOT represented as working or enabled feeds.
  'les-echos': pending('Les Échos', 'https://www.lesechos.fr/'),
  'la-croix': pending('La Croix', 'https://www.la-croix.com/'),
  'la-tribune': pending('La Tribune', 'https://www.latribune.fr/'),
  'sud-ouest': pending('Sud Ouest', 'https://www.sudouest.fr/', '75'),
  'la-voix-du-nord': pending('La Voix du Nord', 'https://www.lavoixdunord.fr/', '32'),
  'le-dauphine': pending('Le Dauphiné libéré', 'https://www.ledauphine.com/'),
  'le-telegramme': pending('Le Télégramme', 'https://www.letelegramme.fr/', '53'),
  // Public RSS metadata verified through 2026-10-08; this catalogue alone never enables publication.
  'le-monde': { ...publisher('Le Monde', 'https://www.lemonde.fr/rss/une.xml'),
    reference: 'https://www.lemonde.fr/le-monde-et-vous/article/2025/07/14/les-flux-rss-du-monde-fr_5498778_3237.html' },
  // National positive-editorial lanes. They complement local news and are
  // ranked from the user's feed priorities; they never replace nearby news.
  'cnrs-journal': publisher('Le Journal du CNRS', 'https://lejournal.cnrs.fr/rss', null, 'science'),
  'futura-sciences': publisher('Futura', 'https://www.futura-sciences.com/rss/actualites.xml', null, 'science'),
  'pour-la-science': publisher('Pour la Science', 'https://www.pourlascience.fr/rss.xml', null, 'science'),
  'le-monde-sciences': publisher('Le Monde — Sciences', 'https://www.lemonde.fr/sciences/rss_full.xml', null, 'science'),
  'the-conversation-education': publisher('The Conversation — Éducation', 'https://theconversation.com/fr/education/articles.atom', null, 'education'),
  'le-monde-education': publisher('Le Monde — Éducation', 'https://www.lemonde.fr/education/rss_full.xml', null, 'education'),
  'cafe-pedagogique': publisher('Le Café pédagogique', 'https://www.cafepedagogique.net/feed/', null, 'education'),
  'le-monde-musiques': publisher('Le Monde — Musiques', 'https://www.lemonde.fr/musiques/rss_full.xml', null, 'music'),
  'france-musique': publisher('France Musique', 'https://www.radiofrance.fr/francemusique/rss', null, 'music'),
  'tsugi': publisher('Tsugi', 'https://www.tsugi.fr/feed/', null, 'music'),
  'the-conversation-sante': publisher('The Conversation — Santé', 'https://theconversation.com/fr/sante/articles.atom', null, 'wellbeing'),
  'psychologies': publisher('Psychologies', 'https://www.psychologies.com/feed', null, 'wellbeing'),
  'sante-publique-france-sante-mentale': publisher('Santé publique France — Santé mentale', 'https://www.santepubliquefrance.fr/rss/1060', null, 'wellbeing'),
  'le-monde-sport': publisher('Le Monde — Sport', 'https://www.lemonde.fr/sport/rss_full.xml', null, 'sport'),
  'franceinfo-sports': publisher('franceinfo — Sports', 'https://www.franceinfo.fr/sports.rss', null, 'sport'),
  'rmc-sport': publisher('RMC Sport', 'https://rmcsport.bfmtv.com/rss/fil-sport/', null, 'sport'),
  'le-figaro': publisher('Le Figaro', 'https://www.lefigaro.fr/rss/figaro_actualites.xml'),
  'liberation': publisher('Libération', 'https://www.liberation.fr/arc/outboundfeeds/rss-all/?outputType=xml'),
  'humanite': publisher('L’Humanité', 'https://www.humanite.fr/feed'),
  'ouest-france': publisher('Ouest-France — Une générale', 'https://www.ouest-france.fr/rss/une'),
  'la-depeche': publisher('La Dépêche du Midi', 'https://www.ladepeche.fr/rss.xml', '76'),
  'midi-libre': publisher('Midi Libre', 'https://www.midilibre.fr/rss.xml', '76'),
  'lindependant': publisher('L’Indépendant', 'https://www.lindependant.fr/rss.xml', '76'),
  // This general edition spans multiple regions; do not mislabel it as a single local edition.
  'est-republicain': publisher('L’Est Républicain — Une générale', 'https://www.estrepublicain.fr/actualite/rss'),
  'dna': publisher('Dernières Nouvelles d’Alsace', 'https://www.dna.fr/actualite/rss', '44'),
  'lalsace': publisher('L’Alsace', 'https://www.lalsace.fr/actualite/rss', '44'),
  'republicain-lorrain': publisher('Le Républicain Lorrain', 'https://www.republicain-lorrain.fr/actualite/rss', '44'),
  'bien-public': publisher('Le Bien Public', 'https://www.bienpublic.com/actualite/rss', '27'),
  'jsl': publisher('Le Journal de Saône-et-Loire', 'https://www.lejsl.com/actualite/rss', '27'),
  'nice-matin': publisher('Nice-Matin', 'https://www.nicematin.com/rss', '93'),
  'le-parisien': {
    name: 'Le Parisien', url: 'https://feeds.leparisien.fr/leparisien/rss',
    websiteHost: 'www.leparisien.fr', verified: true, regionCode: null, city: null,
    reference: 'https://www.leparisien.fr/services/rss/',
  },
  'actu-auvergne-rhone-alpes': actu('auvergne-rhone-alpes', '84'),
  'actu-bourgogne-franche-comte': actu('bourgogne-franche-comte', '27'),
  'actu-bretagne': actu('bretagne', '53'),
  'actu-centre-val-de-loire': actu('centre-val-de-loire', '24'),
  'actu-corse': actu('corse', '94'),
  'actu-grand-est': actu('grand-est', '44'),
  'actu-hauts-de-france': actu('hauts-de-france', '32'),
  'actu-ile-de-france': actu('ile-de-france', '11'),
  'actu-normandie': actu('normandie', '28'),
  'actu-nouvelle-aquitaine': actu('nouvelle-aquitaine', '75'),
  'actu-occitanie': actu('occitanie', '76'),
  'actu-pays-de-la-loire': actu('pays-de-la-loire', '52'),
  'actu-provence-alpes-cote-d-azur': actu('provence-alpes-cote-d-azur', '93'),
  'actu-martinique': actu('martinique', '02'),
  'actu-guyane': actu('guyane', '03'),
  'actu-la-reunion': actu('la-reunion', '04'),
  'actu-mayotte': actu('mayotte', '06'),
  'france-antilles-guadeloupe': {
    name: 'France-Antilles — Guadeloupe', url: 'https://www.guadeloupe.franceantilles.fr/actualite/rss.xml',
    websiteHost: 'www.guadeloupe.franceantilles.fr', verified: true, regionCode: '01', city: null,
    reference: 'https://www.guadeloupe.franceantilles.fr/pages/fil-rss-guadeloupe',
  },
  'la-provence-marseille': {
    name: 'La Provence — Marseille', url: 'https://www.laprovence.com/rss/marseille.xml',
    websiteHost: 'www.laprovence.com', verified: true, regionCode: '93', city: 'Marseille',
    reference: 'https://www.laprovence.com/rss/marseille.xml',
  },
  'le-progres-rhone': {
    name: 'Le Progrès — Rhône', url: 'https://www.leprogres.fr/rhone/rss',
    websiteHost: 'www.leprogres.fr', verified: true, regionCode: '84', city: null,
    reference: 'https://www.leprogres.fr/flux-rss',
  },
  'le-progres-jura': {
    name: 'Le Progrès — Jura', url: 'https://www.leprogres.fr/jura/rss',
    websiteHost: 'www.leprogres.fr', verified: true, regionCode: '27', city: null,
    reference: 'https://www.leprogres.fr/flux-rss',
  },
  'lunion-lardennais': {
    name: 'L’Union / L’Ardennais', url: null,
    websiteHost: null, verified: false, regionCode: '44', city: null,
    reference: 'https://abonnement.lunion.fr/mentions-legales-un',
  },
  'corse-net-infos': {
    name: 'Corse Net Infos', url: 'https://www.corsenetinfos.corsica/xml/syndication.rss',
    websiteHost: 'www.corsenetinfos.corsica', verified: true, regionCode: '94', city: null,
    reference: 'https://www.corsenetinfos.corsica/',
  },
  'mayotte-hebdo': {
    name: 'Mayotte Hebdo', url: 'https://www.mayottehebdo.com/feed/',
    websiteHost: 'www.mayottehebdo.com', verified: true, regionCode: '06', city: null,
    reference: 'https://www.mayottehebdo.com/',
  },
  'imaz-press-reunion': {
    name: 'Imaz Press Réunion', url: 'https://imazpress.com/feed',
    websiteHost: 'imazpress.com', verified: true, regionCode: '04', city: null,
    reference: 'https://imazpress.com/',
  },
  'rci-guadeloupe': {
    name: 'RCI — Guadeloupe', url: 'https://rci.fm/guadeloupe/fb/articles_rss_gp',
    websiteHost: 'rci.fm', verified: true, regionCode: '01', city: null,
    reference: 'https://rci.fm/guadeloupe/',
  },
  'rci-martinique': {
    name: 'RCI — Martinique', url: 'https://rci.fm/martinique/fb/articles_rss_mq',
    websiteHost: 'rci.fm', verified: true, regionCode: '02', city: null,
    reference: 'https://rci.fm/martinique/',
  },
  'france-guyane-vie-locale': {
    name: 'France-Guyane — Vie locale', url: 'https://www.franceguyane.fr/actualite/vielocale/rss.xml',
    websiteHost: 'www.franceguyane.fr', verified: true, regionCode: '03', city: null,
    reference: 'https://www.franceguyane.fr/pages/fil-rss-guyane',
  },
  'france-guyane-faits-divers': {
    name: 'France-Guyane — Faits divers', url: 'https://www.franceguyane.fr/actualite/faitsdivers/rss.xml',
    websiteHost: 'www.franceguyane.fr', verified: true, regionCode: '03', city: null,
    reference: 'https://www.franceguyane.fr/pages/fil-rss-guyane',
  },
};

export function rssDestination(key: string, websiteHost: string): string {
  const entry = Object.prototype.hasOwnProperty.call(RSS_CATALOG, key) ? RSS_CATALOG[key as keyof typeof RSS_CATALOG] : null;
  if (!entry?.verified || !entry.url || entry.websiteHost !== websiteHost) throw new Error('SOURCE_NOT_VERIFIED');
  return entry.url;
}

const normalize = (s: string | null | undefined) => (s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '');
export function assertRssCoverage(key: string, location: { country: string; region: string | null; city: string | null }) {
  const entry = RSS_CATALOG[key];
  if (!entry || location.country !== 'FR'
    || normalize(location.region) !== normalize(entry.regionCode ? FRENCH_REGIONS[entry.regionCode] : null)
    || normalize(location.city) !== normalize(entry.city)) throw new Error('SOURCE_COVERAGE_MISMATCH');
}
