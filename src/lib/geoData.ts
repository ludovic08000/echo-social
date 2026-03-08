// Geographic data for ad targeting — structured for EU expansion
// To add a new country: add entry to COUNTRIES, GEO_DATA, and POPULATION_FILTERS

export interface Ville {
  nom: string;
  population: number;
}

export interface Country {
  code: string;
  label: string;
  flag: string;
  enabled: boolean; // toggle when ready to launch
}

export const COUNTRIES: Country[] = [
  { code: 'FR', label: 'France', flag: '🇫🇷', enabled: true },
  { code: 'BE', label: 'Belgique', flag: '🇧🇪', enabled: true },
  { code: 'CH', label: 'Suisse', flag: '🇨🇭', enabled: true },
  { code: 'LU', label: 'Luxembourg', flag: '🇱🇺', enabled: true },
  { code: 'DE', label: 'Allemagne', flag: '🇩🇪', enabled: true },
  { code: 'ES', label: 'Espagne', flag: '🇪🇸', enabled: true },
  { code: 'IT', label: 'Italie', flag: '🇮🇹', enabled: true },
  { code: 'PT', label: 'Portugal', flag: '🇵🇹', enabled: true },
  { code: 'NL', label: 'Pays-Bas', flag: '🇳🇱', enabled: true },
  { code: 'AT', label: 'Autriche', flag: '🇦🇹', enabled: true },
  { code: 'IE', label: 'Irlande', flag: '🇮🇪', enabled: true },
  { code: 'PL', label: 'Pologne', flag: '🇵🇱', enabled: true },
];

export const ENABLED_COUNTRIES = COUNTRIES.filter(c => c.enabled);

// GEO_DATA[countryCode][regionName] = Ville[]
export const GEO_DATA: Record<string, Record<string, Ville[]>> = {
  FR: {
    'Île-de-France': [
      { nom: 'Paris', population: 2161000 }, { nom: 'Boulogne-Billancourt', population: 121000 },
      { nom: 'Saint-Denis', population: 113000 }, { nom: 'Argenteuil', population: 113000 },
      { nom: 'Montreuil', population: 111000 }, { nom: 'Nanterre', population: 96000 },
      { nom: 'Créteil', population: 93000 }, { nom: 'Versailles', population: 85000 },
      { nom: 'Vitry-sur-Seine', population: 94000 }, { nom: 'Colombes', population: 86000 },
      { nom: 'Aubervilliers', population: 89000 }, { nom: 'Asnières-sur-Seine', population: 87000 },
      { nom: 'Courbevoie', population: 82000 }, { nom: 'Rueil-Malmaison', population: 80000 },
      { nom: 'Champigny-sur-Marne', population: 78000 }, { nom: 'Meaux', population: 55000 },
      { nom: 'Évry-Courcouronnes', population: 69000 }, { nom: 'Cergy', population: 67000 },
      { nom: 'Issy-les-Moulineaux', population: 69000 }, { nom: 'Levallois-Perret', population: 66000 },
    ],
    'Auvergne-Rhône-Alpes': [
      { nom: 'Lyon', population: 522000 }, { nom: 'Grenoble', population: 158000 },
      { nom: 'Saint-Étienne', population: 174000 }, { nom: 'Clermont-Ferrand', population: 147000 },
      { nom: 'Villeurbanne', population: 154000 }, { nom: 'Annecy', population: 132000 },
      { nom: 'Valence', population: 65000 }, { nom: 'Chambéry', population: 59000 },
      { nom: 'Bourg-en-Bresse', population: 42000 }, { nom: 'Vénissieux', population: 66000 },
      { nom: 'Caluire-et-Cuire', population: 44000 }, { nom: 'Roanne', population: 35000 },
    ],
    'Nouvelle-Aquitaine': [
      { nom: 'Bordeaux', population: 259000 }, { nom: 'Limoges', population: 130000 },
      { nom: 'Poitiers', population: 90000 }, { nom: 'La Rochelle', population: 79000 },
      { nom: 'Pau', population: 78000 }, { nom: 'Mérignac', population: 74000 },
      { nom: 'Pessac', population: 65000 }, { nom: 'Angoulême', population: 42000 },
      { nom: 'Bayonne', population: 52000 }, { nom: 'Niort', population: 59000 },
      { nom: 'Brive-la-Gaillarde', population: 47000 }, { nom: 'Agen', population: 35000 },
    ],
    'Occitanie': [
      { nom: 'Toulouse', population: 498000 }, { nom: 'Montpellier', population: 295000 },
      { nom: 'Nîmes', population: 148000 }, { nom: 'Perpignan', population: 121000 },
      { nom: 'Béziers', population: 78000 }, { nom: 'Narbonne', population: 55000 },
      { nom: 'Carcassonne', population: 47000 }, { nom: 'Albi', population: 50000 },
      { nom: 'Tarbes', population: 42000 }, { nom: 'Sète', population: 44000 },
      { nom: 'Castres', population: 41000 }, { nom: 'Rodez', population: 24000 },
    ],
    'Hauts-de-France': [
      { nom: 'Lille', population: 236000 }, { nom: 'Amiens', population: 136000 },
      { nom: 'Roubaix', population: 98000 }, { nom: 'Tourcoing', population: 98000 },
      { nom: 'Dunkerque', population: 87000 }, { nom: 'Calais', population: 73000 },
      { nom: 'Boulogne-sur-Mer', population: 42000 }, { nom: 'Beauvais', population: 56000 },
      { nom: 'Compiègne', population: 41000 }, { nom: 'Saint-Quentin', population: 55000 },
      { nom: 'Valenciennes', population: 43000 }, { nom: 'Lens', population: 32000 },
    ],
    'Provence-Alpes-Côte d\'Azur': [
      { nom: 'Marseille', population: 873000 }, { nom: 'Nice', population: 342000 },
      { nom: 'Toulon', population: 176000 }, { nom: 'Aix-en-Provence', population: 147000 },
      { nom: 'Avignon', population: 92000 }, { nom: 'Cannes', population: 75000 },
      { nom: 'Antibes', population: 73000 }, { nom: 'Fréjus', population: 55000 },
      { nom: 'Arles', population: 52000 }, { nom: 'Gap', population: 41000 },
      { nom: 'Hyères', population: 57000 }, { nom: 'Grasse', population: 51000 },
    ],
    'Grand Est': [
      { nom: 'Strasbourg', population: 287000 }, { nom: 'Reims', population: 184000 },
      { nom: 'Metz', population: 120000 }, { nom: 'Mulhouse', population: 109000 },
      { nom: 'Nancy', population: 105000 }, { nom: 'Colmar', population: 70000 },
      { nom: 'Troyes', population: 62000 }, { nom: 'Charleville-Mézières', population: 47000 },
      { nom: 'Épinal', population: 33000 }, { nom: 'Châlons-en-Champagne', population: 44000 },
      { nom: 'Haguenau', population: 36000 }, { nom: 'Thionville', population: 42000 },
    ],
    'Pays de la Loire': [
      { nom: 'Nantes', population: 320000 }, { nom: 'Angers', population: 157000 },
      { nom: 'Le Mans', population: 146000 }, { nom: 'Saint-Nazaire', population: 72000 },
      { nom: 'La Roche-sur-Yon', population: 55000 }, { nom: 'Cholet', population: 55000 },
      { nom: 'Laval', population: 53000 }, { nom: 'Saumur', population: 28000 },
    ],
    'Bretagne': [
      { nom: 'Rennes', population: 222000 }, { nom: 'Brest', population: 142000 },
      { nom: 'Quimper', population: 63000 }, { nom: 'Lorient', population: 57000 },
      { nom: 'Vannes', population: 55000 }, { nom: 'Saint-Brieuc', population: 45000 },
      { nom: 'Saint-Malo', population: 47000 }, { nom: 'Lannion', population: 20000 },
    ],
    'Normandie': [
      { nom: 'Rouen', population: 114000 }, { nom: 'Le Havre', population: 172000 },
      { nom: 'Caen', population: 107000 }, { nom: 'Cherbourg-en-Cotentin', population: 79000 },
      { nom: 'Évreux', population: 51000 }, { nom: 'Dieppe', population: 30000 },
      { nom: 'Alençon', population: 26000 }, { nom: 'Lisieux', population: 21000 },
    ],
    'Bourgogne-Franche-Comté': [
      { nom: 'Dijon', population: 159000 }, { nom: 'Besançon', population: 120000 },
      { nom: 'Belfort', population: 46000 }, { nom: 'Chalon-sur-Saône', population: 45000 },
      { nom: 'Auxerre', population: 35000 }, { nom: 'Nevers', population: 33000 },
      { nom: 'Mâcon', population: 34000 }, { nom: 'Sens', population: 26000 },
    ],
    'Centre-Val de Loire': [
      { nom: 'Tours', population: 136000 }, { nom: 'Orléans', population: 116000 },
      { nom: 'Bourges', population: 66000 }, { nom: 'Blois', population: 47000 },
      { nom: 'Chartres', population: 39000 }, { nom: 'Châteauroux', population: 43000 },
      { nom: 'Vierzon', population: 27000 }, { nom: 'Dreux', population: 31000 },
    ],
    'Corse': [
      { nom: 'Ajaccio', population: 73000 }, { nom: 'Bastia', population: 48000 },
      { nom: 'Porto-Vecchio', population: 12000 }, { nom: 'Corte', population: 7000 },
    ],
  },

  // ── Belgique (placeholder — à compléter lors du lancement BE) ──
  BE: {
    'Bruxelles-Capitale': [
      { nom: 'Bruxelles', population: 185000 }, { nom: 'Schaerbeek', population: 133000 },
      { nom: 'Anderlecht', population: 120000 }, { nom: 'Ixelles', population: 87000 },
    ],
    'Wallonie': [
      { nom: 'Charleroi', population: 202000 }, { nom: 'Liège', population: 197000 },
      { nom: 'Namur', population: 112000 }, { nom: 'Mons', population: 95000 },
      { nom: 'Tournai', population: 69000 },
    ],
    'Flandre': [
      { nom: 'Anvers', population: 530000 }, { nom: 'Gand', population: 263000 },
      { nom: 'Bruges', population: 118000 }, { nom: 'Louvain', population: 102000 },
    ],
  },

  // ── Suisse (placeholder) ──
  CH: {
    'Suisse romande': [
      { nom: 'Genève', population: 203000 }, { nom: 'Lausanne', population: 140000 },
      { nom: 'Fribourg', population: 38000 }, { nom: 'Neuchâtel', population: 34000 },
    ],
    'Suisse alémanique': [
      { nom: 'Zurich', population: 421000 }, { nom: 'Berne', population: 134000 },
      { nom: 'Bâle', population: 178000 }, { nom: 'Lucerne', population: 82000 },
    ],
    'Tessin': [
      { nom: 'Lugano', population: 63000 }, { nom: 'Bellinzona', population: 44000 },
    ],
  },

  // ── Luxembourg (placeholder) ──
  LU: {
    'Luxembourg': [
      { nom: 'Luxembourg-Ville', population: 132000 }, { nom: 'Esch-sur-Alzette', population: 36000 },
      { nom: 'Differdange', population: 28000 },
    ],
  },

  // ── Allemagne (placeholder) ──
  DE: {
    'Bavière': [
      { nom: 'Munich', population: 1472000 }, { nom: 'Nuremberg', population: 518000 },
      { nom: 'Augsbourg', population: 296000 },
    ],
    'Rhénanie-du-Nord-Westphalie': [
      { nom: 'Cologne', population: 1084000 }, { nom: 'Düsseldorf', population: 621000 },
      { nom: 'Dortmund', population: 588000 }, { nom: 'Essen', population: 583000 },
    ],
    'Berlin': [
      { nom: 'Berlin', population: 3645000 },
    ],
    'Hambourg': [
      { nom: 'Hambourg', population: 1853000 },
    ],
    'Bade-Wurtemberg': [
      { nom: 'Stuttgart', population: 635000 }, { nom: 'Mannheim', population: 310000 },
      { nom: 'Karlsruhe', population: 308000 },
    ],
  },

  // ── Espagne (placeholder) ──
  ES: {
    'Communauté de Madrid': [
      { nom: 'Madrid', population: 3223000 },
    ],
    'Catalogne': [
      { nom: 'Barcelone', population: 1621000 },
    ],
    'Andalousie': [
      { nom: 'Séville', population: 688000 }, { nom: 'Malaga', population: 578000 },
    ],
    'Communauté valencienne': [
      { nom: 'Valence', population: 792000 },
    ],
  },

  // ── Italie (placeholder) ──
  IT: {
    'Lombardie': [
      { nom: 'Milan', population: 1352000 },
    ],
    'Latium': [
      { nom: 'Rome', population: 2873000 },
    ],
    'Campanie': [
      { nom: 'Naples', population: 967000 },
    ],
  },
};

export const POPULATION_FILTERS = [
  { label: 'Toutes', min: 0, max: Infinity },
  { label: '< 30 000', min: 0, max: 30000 },
  { label: '30 000 - 60 000', min: 30000, max: 60000 },
  { label: '60 000 - 100 000', min: 60000, max: 100000 },
  { label: '100 000 - 200 000', min: 100000, max: 200000 },
  { label: '> 200 000', min: 200000, max: Infinity },
];

/** Get regions for a country */
export function getRegions(countryCode: string): string[] {
  return Object.keys(GEO_DATA[countryCode] || {});
}

/** Get cities for a country + region, filtered by population */
export function getCities(countryCode: string, region: string, popFilterIndex = 0, search = ''): Ville[] {
  const villes = GEO_DATA[countryCode]?.[region] || [];
  const filter = POPULATION_FILTERS[popFilterIndex] || POPULATION_FILTERS[0];
  return villes
    .filter(v => v.population >= filter.min && v.population < filter.max)
    .filter(v => !search || v.nom.toLowerCase().includes(search.toLowerCase()));
}

/** Location data saved in campaigns */
export interface TargetLocation {
  country: string; // country code
  region: string | null;
  villes: string[];
}

export function getDefaultLocation(): TargetLocation {
  return { country: 'FR', region: null, villes: [] };
}
