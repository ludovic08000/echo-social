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

  // ── Belgique ──
  BE: {
    'Bruxelles-Capitale': [
      { nom: 'Bruxelles', population: 185000 }, { nom: 'Schaerbeek', population: 133000 },
      { nom: 'Anderlecht', population: 120000 }, { nom: 'Ixelles', population: 87000 },
      { nom: 'Molenbeek-Saint-Jean', population: 97000 }, { nom: 'Uccle', population: 83000 },
      { nom: 'Forest', population: 56000 }, { nom: 'Jette', population: 52000 },
      { nom: 'Etterbeek', population: 48000 }, { nom: 'Saint-Gilles', population: 50000 },
      { nom: 'Woluwe-Saint-Lambert', population: 56000 }, { nom: 'Evere', population: 42000 },
    ],
    'Wallonie': [
      { nom: 'Charleroi', population: 202000 }, { nom: 'Liège', population: 197000 },
      { nom: 'Namur', population: 112000 }, { nom: 'Mons', population: 95000 },
      { nom: 'Tournai', population: 69000 }, { nom: 'La Louvière', population: 80000 },
      { nom: 'Seraing', population: 64000 }, { nom: 'Verviers', population: 56000 },
      { nom: 'Mouscron', population: 58000 }, { nom: 'Arlon', population: 30000 },
      { nom: 'Wavre', population: 35000 }, { nom: 'Nivelles', population: 28000 },
      { nom: 'Ottignies-Louvain-la-Neuve', population: 31000 }, { nom: 'Sambreville', population: 28000 },
    ],
    'Flandre': [
      { nom: 'Anvers', population: 530000 }, { nom: 'Gand', population: 263000 },
      { nom: 'Bruges', population: 118000 }, { nom: 'Louvain', population: 102000 },
      { nom: 'Malines', population: 87000 }, { nom: 'Hasselt', population: 78000 },
      { nom: 'Courtrai', population: 77000 }, { nom: 'Ostende', population: 72000 },
      { nom: 'Genk', population: 66000 }, { nom: 'Saint-Nicolas', population: 78000 },
      { nom: 'Roulers', population: 62000 }, { nom: 'Turnhout', population: 45000 },
      { nom: 'Alost', population: 86000 }, { nom: 'Termonde', population: 46000 },
    ],
  },

  // ── Suisse ──
  CH: {
    'Suisse romande': [
      { nom: 'Genève', population: 203000 }, { nom: 'Lausanne', population: 140000 },
      { nom: 'Fribourg', population: 38000 }, { nom: 'Neuchâtel', population: 34000 },
      { nom: 'Sion', population: 35000 }, { nom: 'Montreux', population: 26000 },
      { nom: 'Yverdon-les-Bains', population: 30000 }, { nom: 'Nyon', population: 21000 },
      { nom: 'Vevey', population: 20000 }, { nom: 'La Chaux-de-Fonds', population: 37000 },
      { nom: 'Bienne', population: 55000 }, { nom: 'Delémont', population: 12000 },
      { nom: 'Renens', population: 22000 }, { nom: 'Morges', population: 16000 },
    ],
    'Suisse alémanique': [
      { nom: 'Zurich', population: 421000 }, { nom: 'Berne', population: 134000 },
      { nom: 'Bâle', population: 178000 }, { nom: 'Lucerne', population: 82000 },
      { nom: 'Saint-Gall', population: 76000 }, { nom: 'Winterthour', population: 115000 },
      { nom: 'Thoune', population: 44000 }, { nom: 'Aarau', population: 22000 },
      { nom: 'Schaffhouse', population: 37000 }, { nom: 'Zoug', population: 30000 },
      { nom: 'Köniz', population: 42000 }, { nom: 'Emmen', population: 31000 },
      { nom: 'Rapperswil-Jona', population: 27000 }, { nom: 'Uster', population: 35000 },
      { nom: 'Dietikon', population: 28000 }, { nom: 'Dübendorf', population: 29000 },
    ],
    'Tessin': [
      { nom: 'Lugano', population: 63000 }, { nom: 'Bellinzona', population: 44000 },
      { nom: 'Locarno', population: 16000 }, { nom: 'Mendrisio', population: 15000 },
      { nom: 'Chiasso', population: 8000 },
    ],
  },

  // ── Luxembourg ──
  LU: {
    'Luxembourg': [
      { nom: 'Luxembourg-Ville', population: 132000 }, { nom: 'Esch-sur-Alzette', population: 36000 },
      { nom: 'Differdange', population: 28000 }, { nom: 'Dudelange', population: 21000 },
      { nom: 'Ettelbruck', population: 10000 }, { nom: 'Pétange', population: 20000 },
      { nom: 'Sanem', population: 17000 }, { nom: 'Hesperange', population: 16000 },
      { nom: 'Schifflange', population: 12000 }, { nom: 'Bettembourg', population: 11000 },
    ],
  },

  // ── Allemagne ──
  DE: {
    'Bavière': [
      { nom: 'Munich', population: 1472000 }, { nom: 'Nuremberg', population: 518000 },
      { nom: 'Augsbourg', population: 296000 }, { nom: 'Ratisbonne', population: 153000 },
      { nom: 'Ingolstadt', population: 139000 }, { nom: 'Fürth', population: 129000 },
      { nom: 'Würzburg', population: 128000 }, { nom: 'Erlangen', population: 113000 },
      { nom: 'Bamberg', population: 78000 }, { nom: 'Bayreuth', population: 75000 },
      { nom: 'Landshut', population: 73000 }, { nom: 'Aschaffenburg', population: 71000 },
      { nom: 'Passau', population: 53000 }, { nom: 'Rosenheim', population: 64000 },
    ],
    'Rhénanie-du-Nord-Westphalie': [
      { nom: 'Cologne', population: 1084000 }, { nom: 'Düsseldorf', population: 621000 },
      { nom: 'Dortmund', population: 588000 }, { nom: 'Essen', population: 583000 },
      { nom: 'Duisbourg', population: 498000 }, { nom: 'Bochum', population: 365000 },
      { nom: 'Wuppertal', population: 355000 }, { nom: 'Bielefeld', population: 334000 },
      { nom: 'Bonn', population: 331000 }, { nom: 'Münster', population: 317000 },
      { nom: 'Gelsenkirchen', population: 260000 }, { nom: 'Mönchengladbach', population: 261000 },
      { nom: 'Aix-la-Chapelle', population: 249000 }, { nom: 'Krefeld', population: 228000 },
      { nom: 'Oberhausen', population: 211000 }, { nom: 'Hagen', population: 189000 },
      { nom: 'Hamm', population: 179000 }, { nom: 'Paderborn', population: 154000 },
      { nom: 'Solingen', population: 159000 }, { nom: 'Leverkusen', population: 164000 },
    ],
    'Berlin': [
      { nom: 'Berlin', population: 3645000 },
    ],
    'Hambourg': [
      { nom: 'Hambourg', population: 1853000 },
    ],
    'Bade-Wurtemberg': [
      { nom: 'Stuttgart', population: 635000 }, { nom: 'Mannheim', population: 310000 },
      { nom: 'Karlsruhe', population: 308000 }, { nom: 'Fribourg-en-Brisgau', population: 231000 },
      { nom: 'Heidelberg', population: 160000 }, { nom: 'Heilbronn', population: 126000 },
      { nom: 'Ulm', population: 126000 }, { nom: 'Pforzheim', population: 125000 },
      { nom: 'Reutlingen', population: 116000 }, { nom: 'Esslingen', population: 94000 },
      { nom: 'Tübingen', population: 91000 }, { nom: 'Constance', population: 85000 },
    ],
    'Hesse': [
      { nom: 'Francfort-sur-le-Main', population: 753000 }, { nom: 'Wiesbaden', population: 278000 },
      { nom: 'Cassel', population: 201000 }, { nom: 'Darmstadt', population: 159000 },
      { nom: 'Offenbach', population: 130000 }, { nom: 'Giessen', population: 90000 },
      { nom: 'Marbourg', population: 77000 }, { nom: 'Fulda', population: 69000 },
    ],
    'Basse-Saxe': [
      { nom: 'Hanovre', population: 536000 }, { nom: 'Brunswick', population: 249000 },
      { nom: 'Oldenbourg', population: 170000 }, { nom: 'Osnabrück', population: 165000 },
      { nom: 'Göttingen', population: 120000 }, { nom: 'Wolfsbourg', population: 124000 },
      { nom: 'Hildesheim', population: 101000 }, { nom: 'Salzgitter', population: 104000 },
    ],
    'Saxe': [
      { nom: 'Leipzig', population: 597000 }, { nom: 'Dresde', population: 556000 },
      { nom: 'Chemnitz', population: 246000 }, { nom: 'Zwickau', population: 90000 },
    ],
    'Brême': [
      { nom: 'Brême', population: 567000 }, { nom: 'Bremerhaven', population: 114000 },
    ],
    'Schleswig-Holstein': [
      { nom: 'Kiel', population: 247000 }, { nom: 'Lübeck', population: 217000 },
      { nom: 'Flensbourg', population: 90000 },
    ],
  },

  // ── Espagne ──
  ES: {
    'Communauté de Madrid': [
      { nom: 'Madrid', population: 3223000 }, { nom: 'Móstoles', population: 207000 },
      { nom: 'Alcalá de Henares', population: 197000 }, { nom: 'Fuenlabrada', population: 195000 },
      { nom: 'Leganés', population: 189000 }, { nom: 'Getafe', population: 183000 },
      { nom: 'Alcorcón', population: 170000 }, { nom: 'Torrejón de Ardoz', population: 131000 },
      { nom: 'Parla', population: 130000 }, { nom: 'Alcobendas', population: 117000 },
    ],
    'Catalogne': [
      { nom: 'Barcelone', population: 1621000 }, { nom: 'Hospitalet de Llobregat', population: 264000 },
      { nom: 'Badalona', population: 223000 }, { nom: 'Terrassa', population: 223000 },
      { nom: 'Sabadell', population: 213000 }, { nom: 'Tarragone', population: 132000 },
      { nom: 'Lérida', population: 139000 }, { nom: 'Mataró', population: 129000 },
      { nom: 'Gérone', population: 103000 }, { nom: 'Reus', population: 107000 },
    ],
    'Andalousie': [
      { nom: 'Séville', population: 688000 }, { nom: 'Malaga', population: 578000 },
      { nom: 'Cordoue', population: 325000 }, { nom: 'Grenade', population: 232000 },
      { nom: 'Jerez de la Frontera', population: 213000 }, { nom: 'Almería', population: 199000 },
      { nom: 'Huelva', population: 144000 }, { nom: 'Cadix', population: 116000 },
      { nom: 'Jaén', population: 112000 }, { nom: 'Marbella', population: 147000 },
      { nom: 'Algésiras', population: 122000 }, { nom: 'Dos Hermanas', population: 135000 },
    ],
    'Communauté valencienne': [
      { nom: 'Valence', population: 792000 }, { nom: 'Alicante', population: 337000 },
      { nom: 'Elche', population: 234000 }, { nom: 'Castellón de la Plana', population: 174000 },
      { nom: 'Torrevieja', population: 83000 }, { nom: 'Orihuela', population: 78000 },
      { nom: 'Benidorm', population: 69000 }, { nom: 'Gandia', population: 74000 },
    ],
    'Pays basque': [
      { nom: 'Bilbao', population: 346000 }, { nom: 'Vitoria-Gasteiz', population: 252000 },
      { nom: 'Saint-Sébastien', population: 187000 }, { nom: 'Barakaldo', population: 100000 },
      { nom: 'Getxo', population: 78000 }, { nom: 'Irun', population: 62000 },
    ],
    'Galice': [
      { nom: 'Vigo', population: 295000 }, { nom: 'La Corogne', population: 245000 },
      { nom: 'Ourense', population: 106000 }, { nom: 'Saint-Jacques-de-Compostelle', population: 98000 },
      { nom: 'Lugo', population: 99000 }, { nom: 'Pontevedra', population: 83000 },
    ],
    'Îles Canaries': [
      { nom: 'Las Palmas de Gran Canaria', population: 379000 },
      { nom: 'Santa Cruz de Tenerife', population: 207000 },
      { nom: 'San Cristóbal de La Laguna', population: 158000 },
      { nom: 'Arrecife', population: 62000 },
    ],
    'Aragon': [
      { nom: 'Saragosse', population: 675000 }, { nom: 'Huesca', population: 54000 },
      { nom: 'Teruel', population: 36000 },
    ],
  },

  // ── Italie ──
  IT: {
    'Lombardie': [
      { nom: 'Milan', population: 1352000 }, { nom: 'Brescia', population: 200000 },
      { nom: 'Bergame', population: 122000 }, { nom: 'Monza', population: 124000 },
      { nom: 'Côme', population: 84000 }, { nom: 'Pavie', population: 73000 },
      { nom: 'Crémone', population: 72000 }, { nom: 'Varese', population: 81000 },
      { nom: 'Sesto San Giovanni', population: 82000 }, { nom: 'Busto Arsizio', population: 84000 },
    ],
    'Latium': [
      { nom: 'Rome', population: 2873000 }, { nom: 'Latina', population: 127000 },
      { nom: 'Guidonia Montecelio', population: 90000 }, { nom: 'Fiumicino', population: 81000 },
      { nom: 'Viterbe', population: 68000 }, { nom: 'Tivoli', population: 57000 },
    ],
    'Campanie': [
      { nom: 'Naples', population: 967000 }, { nom: 'Salerne', population: 134000 },
      { nom: 'Giugliano in Campania', population: 123000 }, { nom: 'Torre del Greco', population: 86000 },
      { nom: 'Caserte', population: 76000 }, { nom: 'Casoria', population: 78000 },
      { nom: 'Avellino', population: 54000 }, { nom: 'Bénévent', population: 60000 },
    ],
    'Piémont': [
      { nom: 'Turin', population: 870000 }, { nom: 'Novare', population: 105000 },
      { nom: 'Alexandrie', population: 94000 }, { nom: 'Asti', population: 76000 },
      { nom: 'Moncalieri', population: 58000 }, { nom: 'Cuneo', population: 56000 },
      { nom: 'Rivoli', population: 49000 }, { nom: 'Collegno', population: 50000 },
    ],
    'Vénétie': [
      { nom: 'Venise', population: 261000 }, { nom: 'Vérone', population: 259000 },
      { nom: 'Padoue', population: 212000 }, { nom: 'Vicence', population: 112000 },
      { nom: 'Trévise', population: 85000 }, { nom: 'Rovigo', population: 52000 },
    ],
    'Émilie-Romagne': [
      { nom: 'Bologne', population: 392000 }, { nom: 'Parme', population: 198000 },
      { nom: 'Modène', population: 188000 }, { nom: 'Reggio d\'Émilie', population: 172000 },
      { nom: 'Ravenne', population: 160000 }, { nom: 'Rimini', population: 150000 },
      { nom: 'Ferrare', population: 133000 }, { nom: 'Forlì', population: 118000 },
      { nom: 'Plaisance', population: 104000 }, { nom: 'Cesena', population: 97000 },
    ],
    'Toscane': [
      { nom: 'Florence', population: 382000 }, { nom: 'Prato', population: 195000 },
      { nom: 'Livourne', population: 158000 }, { nom: 'Arezzo', population: 100000 },
      { nom: 'Pise', population: 91000 }, { nom: 'Lucques', population: 89000 },
      { nom: 'Pistoia', population: 90000 }, { nom: 'Sienne', population: 54000 },
    ],
    'Sicile': [
      { nom: 'Palerme', population: 663000 }, { nom: 'Catane', population: 311000 },
      { nom: 'Messine', population: 236000 }, { nom: 'Syracuse', population: 122000 },
      { nom: 'Raguse', population: 73000 }, { nom: 'Trapani', population: 68000 },
      { nom: 'Marsala', population: 83000 }, { nom: 'Gela', population: 76000 },
    ],
    'Sardaigne': [
      { nom: 'Cagliari', population: 154000 }, { nom: 'Sassari', population: 127000 },
      { nom: 'Quartu Sant\'Elena', population: 71000 }, { nom: 'Olbia', population: 60000 },
    ],
    'Pouilles': [
      { nom: 'Bari', population: 326000 }, { nom: 'Tarente', population: 195000 },
      { nom: 'Foggia', population: 152000 }, { nom: 'Lecce', population: 95000 },
      { nom: 'Brindisi', population: 88000 }, { nom: 'Andria', population: 100000 },
    ],
    'Ligurie': [
      { nom: 'Gênes', population: 566000 }, { nom: 'La Spezia', population: 94000 },
      { nom: 'Savone', population: 61000 }, { nom: 'Sanremo', population: 55000 },
    ],
  },

  // ── Portugal ──
  PT: {
    'Lisbonne': [
      { nom: 'Lisbonne', population: 545000 }, { nom: 'Sintra', population: 388000 },
      { nom: 'Cascais', population: 210000 }, { nom: 'Loures', population: 200000 },
      { nom: 'Amadora', population: 175000 }, { nom: 'Odivelas', population: 144000 },
      { nom: 'Oeiras', population: 173000 }, { nom: 'Vila Franca de Xira', population: 137000 },
    ],
    'Porto': [
      { nom: 'Porto', population: 238000 }, { nom: 'Vila Nova de Gaia', population: 303000 },
      { nom: 'Matosinhos', population: 175000 }, { nom: 'Gondomar', population: 168000 },
      { nom: 'Maia', population: 136000 }, { nom: 'Valongo', population: 94000 },
    ],
    'Centre': [
      { nom: 'Coimbra', population: 143000 }, { nom: 'Leiria', population: 128000 },
      { nom: 'Viseu', population: 99000 }, { nom: 'Aveiro', population: 78000 },
    ],
    'Algarve': [
      { nom: 'Faro', population: 64000 }, { nom: 'Loulé', population: 70000 },
      { nom: 'Portimão', population: 56000 }, { nom: 'Albufeira', population: 40000 },
    ],
    'Nord': [
      { nom: 'Braga', population: 193000 }, { nom: 'Guimarães', population: 162000 },
      { nom: 'Vila Real', population: 52000 }, { nom: 'Viana do Castelo', population: 89000 },
    ],
  },

  // ── Pays-Bas ──
  NL: {
    'Hollande-Méridionale': [
      { nom: 'Rotterdam', population: 651000 }, { nom: 'La Haye', population: 548000 },
      { nom: 'Leyde', population: 124000 }, { nom: 'Dordrecht', population: 119000 },
      { nom: 'Zoetermeer', population: 125000 }, { nom: 'Delft', population: 103000 },
    ],
    'Hollande-Septentrionale': [
      { nom: 'Amsterdam', population: 873000 }, { nom: 'Haarlem', population: 162000 },
      { nom: 'Zaanstad', population: 155000 }, { nom: 'Haarlemmermeer', population: 155000 },
      { nom: 'Amstelveen', population: 92000 }, { nom: 'Hilversum', population: 90000 },
      { nom: 'Alkmaar', population: 109000 },
    ],
    'Utrecht': [
      { nom: 'Utrecht', population: 358000 }, { nom: 'Amersfoort', population: 157000 },
      { nom: 'Veenendaal', population: 68000 }, { nom: 'Nieuwegein', population: 63000 },
    ],
    'Brabant-Septentrional': [
      { nom: 'Eindhoven', population: 235000 }, { nom: 'Tilbourg', population: 220000 },
      { nom: 'Bréda', population: 184000 }, { nom: 'Bois-le-Duc', population: 155000 },
      { nom: 'Oss', population: 92000 }, { nom: 'Helmond', population: 93000 },
    ],
    'Gueldre': [
      { nom: 'Nimègue', population: 177000 }, { nom: 'Arnhem', population: 161000 },
      { nom: 'Apeldoorn', population: 164000 }, { nom: 'Ede', population: 119000 },
    ],
    'Groningue': [
      { nom: 'Groningue', population: 233000 },
    ],
    'Overijssel': [
      { nom: 'Enschede', population: 160000 }, { nom: 'Zwolle', population: 130000 },
      { nom: 'Deventer', population: 101000 },
    ],
    'Limbourg': [
      { nom: 'Maastricht', population: 122000 }, { nom: 'Venlo', population: 101000 },
      { nom: 'Heerlen', population: 87000 }, { nom: 'Sittard-Geleen', population: 93000 },
    ],
  },

  // ── Autriche ──
  AT: {
    'Vienne': [
      { nom: 'Vienne', population: 1911000 },
    ],
    'Haute-Autriche': [
      { nom: 'Linz', population: 207000 }, { nom: 'Wels', population: 62000 },
      { nom: 'Steyr', population: 38000 },
    ],
    'Styrie': [
      { nom: 'Graz', population: 292000 }, { nom: 'Leoben', population: 25000 },
    ],
    'Salzbourg': [
      { nom: 'Salzbourg', population: 155000 }, { nom: 'Hallein', population: 22000 },
    ],
    'Tyrol': [
      { nom: 'Innsbruck', population: 131000 },
    ],
    'Carinthie': [
      { nom: 'Klagenfurt', population: 101000 }, { nom: 'Villach', population: 63000 },
    ],
    'Basse-Autriche': [
      { nom: 'Saint-Pölten', population: 55000 }, { nom: 'Wiener Neustadt', population: 46000 },
      { nom: 'Baden', population: 26000 }, { nom: 'Krems an der Donau', population: 25000 },
    ],
  },

  // ── Irlande ──
  IE: {
    'Leinster': [
      { nom: 'Dublin', population: 1173000 }, { nom: 'Dún Laoghaire', population: 52000 },
      { nom: 'Drogheda', population: 41000 }, { nom: 'Dundalk', population: 39000 },
      { nom: 'Kilkenny', population: 26000 }, { nom: 'Navan', population: 30000 },
      { nom: 'Swords', population: 42000 }, { nom: 'Bray', population: 33000 },
    ],
    'Munster': [
      { nom: 'Cork', population: 210000 }, { nom: 'Limerick', population: 94000 },
      { nom: 'Waterford', population: 54000 }, { nom: 'Tralee', population: 24000 },
      { nom: 'Ennis', population: 27000 }, { nom: 'Killarney', population: 15000 },
    ],
    'Connacht': [
      { nom: 'Galway', population: 83000 }, { nom: 'Sligo', population: 20000 },
      { nom: 'Castlebar', population: 12000 },
    ],
    'Ulster (IE)': [
      { nom: 'Letterkenny', population: 20000 },
    ],
  },

  // ── Pologne ──
  PL: {
    'Mazovie': [
      { nom: 'Varsovie', population: 1794000 }, { nom: 'Radom', population: 214000 },
      { nom: 'Płock', population: 120000 }, { nom: 'Siedlce', population: 78000 },
      { nom: 'Pruszków', population: 63000 },
    ],
    'Petite-Pologne': [
      { nom: 'Cracovie', population: 780000 }, { nom: 'Tarnów', population: 109000 },
      { nom: 'Nowy Sącz', population: 84000 },
    ],
    'Silésie': [
      { nom: 'Katowice', population: 296000 }, { nom: 'Częstochowa', population: 224000 },
      { nom: 'Sosnowiec', population: 199000 }, { nom: 'Gliwice', population: 180000 },
      { nom: 'Zabrze', population: 174000 }, { nom: 'Bytom', population: 167000 },
      { nom: 'Bielsko-Biała', population: 171000 }, { nom: 'Rybnik', population: 139000 },
      { nom: 'Tychy', population: 128000 },
    ],
    'Grande-Pologne': [
      { nom: 'Poznań', population: 534000 }, { nom: 'Kalisz', population: 101000 },
      { nom: 'Konin', population: 75000 }, { nom: 'Piła', population: 74000 },
    ],
    'Basse-Silésie': [
      { nom: 'Wrocław', population: 643000 }, { nom: 'Wałbrzych', population: 113000 },
      { nom: 'Legnica', population: 100000 }, { nom: 'Jelenia Góra', population: 80000 },
    ],
    'Poméranie': [
      { nom: 'Gdańsk', population: 471000 }, { nom: 'Gdynia', population: 247000 },
      { nom: 'Słupsk', population: 91000 }, { nom: 'Sopot', population: 37000 },
    ],
    'Łódź': [
      { nom: 'Łódź', population: 685000 }, { nom: 'Piotrków Trybunalski', population: 74000 },
    ],
    'Poméranie occidentale': [
      { nom: 'Szczecin', population: 401000 }, { nom: 'Koszalin', population: 108000 },
    ],
    'Lublin': [
      { nom: 'Lublin', population: 340000 }, { nom: 'Zamość', population: 64000 },
      { nom: 'Chełm', population: 63000 },
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
