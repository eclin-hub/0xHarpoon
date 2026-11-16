"use strict";
/* Base géopolitique éditoriale (état connu à mi-2026, à vérifier et compléter) :
   blocs et alliances, relations entre pays, rôle économique, soutiens des camps dans les conflits. */
const GEO = (() => {
  const EU = ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"];
  const NATO = ["AL", "BE", "BG", "CA", "HR", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IS", "IT", "LV", "LT", "LU", "ME", "NL", "MK", "NO", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "TR", "GB", "US"];
  const BLOCS = [
    { id: "nato", name: "OTAN", color: "#4f8cff", kind: "Militaire", members: NATO, desc: "Alliance militaire occidentale : une attaque contre un membre est une attaque contre tous (article 5). 32 membres." },
    { id: "eu", name: "Union européenne", color: "#5fd0ff", kind: "Économique et politique", members: EU, desc: "Marché unique et union douanière de 27 pays ; 20 d'entre eux partagent l'euro. Négocie les accords commerciaux et les sanctions d'un seul bloc." },
    { id: "g7", name: "G7", color: "#9ad1ff", kind: "Économique", members: ["US", "CA", "GB", "FR", "DE", "IT", "JP"], desc: "Les grandes économies occidentales. Coordonne les sanctions (plafond sur le pétrole russe) et la politique économique." },
    { id: "brics", name: "BRICS", color: "#ffb347", kind: "Économique", members: ["BR", "RU", "IN", "CN", "ZA", "EG", "ET", "IR", "AE", "ID"], desc: "Club des grandes économies émergentes, élargi en 2024-2025. Pousse à commercer hors du dollar." },
    { id: "sco", name: "Org. de coopération de Shanghai", color: "#ff7a59", kind: "Sécurité", members: ["CN", "RU", "IN", "PK", "KZ", "KG", "TJ", "UZ", "IR", "BY"], desc: "Forum de sécurité eurasiatique mené par la Chine et la Russie." },
    { id: "csto", name: "OTSC", color: "#ff4d6d", kind: "Militaire", members: ["RU", "BY", "KZ", "KG", "TJ", "AM"], desc: "Alliance militaire autour de la Russie. L'Arménie a gelé sa participation." },
    { id: "opec", name: "OPEP+", color: "#ffd166", kind: "Énergie", members: ["SA", "IQ", "IR", "KW", "AE", "VE", "NG", "LY", "DZ", "CG", "GQ", "GA", "RU", "KZ", "AZ", "BH", "BN", "MY", "MX", "OM", "SD", "SS"], desc: "Producteurs de pétrole qui coordonnent leurs quotas. Environ 40 % de la production mondiale, menés par l'Arabie saoudite et la Russie. Leurs décisions font bouger le baril." },
    { id: "gcc", name: "Conseil de coopération du Golfe", color: "#c9f27b", kind: "Régional", members: ["SA", "AE", "KW", "QA", "BH", "OM"], desc: "Monarchies pétrolières du Golfe : une part majeure des exportations mondiales de pétrole et de gaz, et d'énormes fonds souverains." },
    { id: "quad", name: "Quad et AUKUS", color: "#7cf0c8", kind: "Militaire", members: ["US", "JP", "IN", "AU", "GB"], desc: "Partenariats indo-pacifiques destinés à contenir l'influence chinoise (AUKUS : sous-marins nucléaires pour l'Australie)." },
    { id: "axis", name: "Réseau d'influence iranien", color: "#d36bff", kind: "Influence", members: ["IR", "YE", "LB", "IQ"], desc: "L'Iran et les groupes armés qu'il soutient : Houthis (Yémen), Hezbollah (Liban), milices en Irak. Ce sont des acteurs non étatiques : les pays eux-mêmes ne sont pas tous alignés." },
  ];

  // relations bilatérales principales et rôle économique (sélection des pays qui pèsent sur les marchés)
  const C = {
    US: { allies: ["GB", "JP", "KR", "AU", "CA", "DE", "FR", "IL", "TW", "PH"], rivals: ["CN", "RU", "IR", "KP", "VE"], role: "1re économie mondiale, 1er producteur de pétrole et de gaz, émetteur du dollar (monnaie de réserve)." },
    CN: { allies: ["RU", "PK", "KP"], rivals: ["US", "TW", "IN", "JP", "PH"], role: "2e économie, 1er importateur de pétrole, 1er exportateur mondial, raffine l'essentiel des terres rares.", sanctions: "Restrictions américaines sur les puces et l'équipement de fabrication." },
    RU: { allies: ["BY", "IR", "KP"], rivals: ["UA", "US", "GB", "PL", "EE", "LV", "LT", "FI"], role: "Parmi les 3 premiers producteurs de pétrole, gros exportateur de gaz, blé, engrais, nickel et palladium. Partenaire stratégique de la Chine.", sanctions: "Sanctions occidentales massives depuis 2022 (plafond sur le prix du pétrole, avoirs gelés)." },
    UA: { allies: ["US", "GB", "PL", "DE", "FR", "EE", "LV", "LT", "CA", "NL"], rivals: ["RU", "BY"], role: "Grand exportateur de céréales, maïs et huile de tournesol." },
    BY: { allies: ["RU"], rivals: ["UA", "PL", "LT"], role: "Satellite militaire et économique de la Russie.", sanctions: "Sanctions occidentales." },
    IL: { allies: ["US", "DE", "AE"], rivals: ["IR", "LB", "YE"], role: "Pôle technologique, gisements de gaz offshore." },
    IR: { allies: ["RU", "CN", "YE", "LB", "IQ"], rivals: ["US", "IL", "SA"], role: "4e réserves de pétrole et 2e de gaz au monde, contrôle la rive nord du détroit d'Ormuz. Exporte surtout vers la Chine.", sanctions: "Sanctions américaines et internationales sur le pétrole et le nucléaire." },
    SA: { allies: ["US", "AE", "EG", "PK"], rivals: ["IR", "YE"], role: "1er exportateur de pétrole, pilote de l'OPEP+ ; peut faire varier l'offre mondiale." },
    AE: { allies: ["US", "SA", "IL", "IN", "EG"], rivals: ["IR"], role: "Producteur de pétrole, hub financier et logistique (Dubaï), fonds souverains géants." },
    QA: { allies: ["US", "TR"], rivals: [], role: "Parmi les 2 premiers exportateurs de gaz naturel liquéfié ; médiateur régional." },
    KW: { allies: ["US", "SA"], rivals: ["IQ"], role: "Producteur de pétrole de l'OPEP." },
    IQ: { allies: ["IR", "US"], rivals: [], role: "2e producteur de l'OPEP, tiraillé entre Washington et Téhéran." },
    TR: { allies: ["AZ", "QA", "PK"], rivals: [], role: "Membre de l'OTAN au jeu autonome ; contrôle le Bosphore et les Dardanelles (sortie de la mer Noire)." },
    EG: { allies: ["SA", "AE", "US"], rivals: ["ET"], role: "Contrôle le canal de Suez, très dépendant des recettes du canal et du FMI." },
    IN: { allies: ["US", "JP", "FR", "AU", "RU"], rivals: ["PK", "CN"], role: "Économie à la croissance la plus rapide parmi les grandes, 3e importateur de pétrole, grand acheteur de brut russe." },
    PK: { allies: ["CN", "SA", "TR"], rivals: ["IN", "AF"], role: "Puissance nucléaire, dépend des financements chinois, saoudiens et du FMI." },
    KP: { allies: ["RU", "CN"], rivals: ["US", "KR", "JP"], role: "Puissance nucléaire isolée ; fournit munitions et soldats à la Russie.", sanctions: "Sanctions de l'ONU." },
    KR: { allies: ["US", "JP"], rivals: ["KP"], role: "Puces mémoire (Samsung, SK Hynix), construction navale, batteries." },
    JP: { allies: ["US", "AU", "GB", "KR"], rivals: ["CN", "KP", "RU"], role: "4e économie, 1er détenteur étranger de bons du Trésor américain ; le yen sert de valeur refuge." },
    TW: { allies: ["US", "JP"], rivals: ["CN"], role: "TSMC y fabrique l'essentiel des puces les plus avancées du monde : point névralgique de la tech." },
    PH: { allies: ["US", "JP", "AU"], rivals: ["CN"], role: "En première ligne en mer de Chine méridionale." },
    AU: { allies: ["US", "GB", "JP"], rivals: [], role: "Minerai de fer, lithium, charbon, gaz liquéfié ; très dépendante des exportations vers la Chine." },
    DE: { allies: ["FR", "US", "PL", "NL"], rivals: ["RU"], role: "1re économie européenne, industrie exportatrice sensible au prix de l'énergie et à la demande chinoise." },
    FR: { allies: ["DE", "US", "GB", "IN"], rivals: ["RU"], role: "Puissance nucléaire militaire et civile, membre permanent du Conseil de sécurité." },
    GB: { allies: ["US", "FR", "AU", "CA", "UA"], rivals: ["RU"], role: "Place financière de Londres, puissance nucléaire." },
    PL: { allies: ["US", "UA", "GB"], rivals: ["RU", "BY"], role: "Pivot logistique de l'aide à l'Ukraine, forte hausse des dépenses militaires." },
    NO: { allies: ["US", "GB"], rivals: [], role: "1er fournisseur de gaz de l'Europe, plus grand fonds souverain du monde." },
    CH: { allies: [], rivals: [], role: "Franc suisse valeur refuge, place du négoce de matières premières et de l'or." },
    VE: { allies: ["RU", "CN", "IR", "CU"], rivals: ["US"], role: "Plus grandes réserves prouvées de pétrole au monde, production effondrée.", sanctions: "Sanctions américaines sur le pétrole." },
    MX: { allies: ["US", "CA"], rivals: [], role: "1er partenaire commercial des États-Unis, producteur de pétrole." },
    CA: { allies: ["US", "GB"], rivals: [], role: "1er fournisseur de pétrole des États-Unis ; potasse, uranium, bois." },
    BR: { allies: [], rivals: [], role: "Géant agricole (soja, café, sucre, bœuf) et minier (fer)." },
    AR: { allies: ["US"], rivals: [], role: "Gaz de schiste (Vaca Muerta), lithium, soja ; économie en réforme." },
    CL: { allies: [], rivals: [], role: "1er producteur mondial de cuivre, gros producteur de lithium." },
    ZA: { allies: [], rivals: [], role: "1er producteur de platine, gros producteur d'or et de chrome." },
    NG: { allies: [], rivals: [], role: "1er producteur de pétrole d'Afrique." },
    CD: { allies: [], rivals: ["RW"], role: "1er producteur de cobalt (batteries), gros producteur de cuivre." },
    RW: { allies: [], rivals: ["CD"], role: "Accusé de soutenir les rebelles du M23 dans l'est de la RD Congo." },
    KZ: { allies: ["RU", "CN"], rivals: [], role: "1er producteur d'uranium, pétrole de la Caspienne." },
    AZ: { allies: ["TR", "IL"], rivals: ["AM"], role: "Pétrole et gaz acheminés vers l'Europe sans passer par la Russie." },
    ID: { allies: [], rivals: [], role: "1er producteur de nickel et d'huile de palme, gros exportateur de charbon." },
    SG: { allies: ["US"], rivals: [], role: "Hub financier et maritime sur le détroit de Malacca, par où passe le pétrole vers l'Asie." },
    YE: { allies: ["IR"], rivals: ["SA", "IL", "US"], role: "Les Houthis, qui contrôlent le nord, menacent le détroit de Bab el-Mandeb (accès à la mer Rouge et à Suez)." },
    LB: { allies: ["IR"], rivals: ["IL"], role: "Le Hezbollah, soutenu par l'Iran, y est un acteur armé majeur." },
    LY: { allies: [], rivals: [], role: "Réserves de pétrole importantes, production souvent coupée par les rivalités internes." },
    SD: { allies: [], rivals: [], role: "Guerre civile ; producteur d'or." },
    ET: { allies: [], rivals: ["EG"], role: "Grand barrage sur le Nil, source de tension avec l'Égypte." },
  };

  // soutiens extérieurs des camps, par foyer de tension (identifiants de lib/world.mjs)
  const SIDES = {
    ukraine: [{ name: "Ukraine", iso: ["UA"], support: ["US", "GB", "DE", "FR", "PL", "NL", "SE", "NO", "DK", "FI", "CA", "IT", "EE", "LV", "LT"] }, { name: "Russie", iso: ["RU"], support: ["BY", "IR", "KP"] }],
    gaza: [{ name: "Israël", iso: ["IL"], support: ["US", "DE"] }, { name: "Hamas", iso: ["PS"], support: ["IR"] }],
    iran: [{ name: "Israël et États-Unis", iso: ["IL", "US"], support: [] }, { name: "Iran", iso: ["IR"], support: ["YE", "LB"] }],
    redsea: [{ name: "Houthis", iso: ["YE"], support: ["IR"] }, { name: "Coalition navale", iso: ["US", "GB"], support: ["IL"] }],
    lebanon: [{ name: "Israël", iso: ["IL"], support: ["US"] }, { name: "Hezbollah", iso: ["LB"], support: ["IR"] }],
    taiwan: [{ name: "Taïwan", iso: ["TW"], support: ["US", "JP"] }, { name: "Chine", iso: ["CN"], support: [] }],
    scs: [{ name: "Philippines", iso: ["PH"], support: ["US", "JP", "AU"] }, { name: "Chine", iso: ["CN"], support: [] }],
    korea: [{ name: "Corée du Sud", iso: ["KR"], support: ["US", "JP"] }, { name: "Corée du Nord", iso: ["KP"], support: ["RU", "CN"] }],
    kashmir: [{ name: "Inde", iso: ["IN"], support: [] }, { name: "Pakistan", iso: ["PK"], support: ["CN", "TR"] }],
    venezuela: [{ name: "États-Unis", iso: ["US"], support: [] }, { name: "Venezuela", iso: ["VE"], support: ["RU", "CN", "IR", "CU"] }],
    tradewar: [{ name: "États-Unis", iso: ["US"], support: [] }, { name: "Chine", iso: ["CN"], support: [] }],
    drc: [{ name: "RD Congo", iso: ["CD"], support: [] }, { name: "M23 (Rwanda)", iso: ["RW"], support: [] }],
    thaicam: [{ name: "Thaïlande", iso: ["TH"], support: [] }, { name: "Cambodge", iso: ["KH"], support: [] }],
  };

  // points d'ancrage des pays absents ou mal centrés sur la carte simplifiée
  const PIN = { US: [-98, 39], FR: [2.4, 46.6], NO: [9, 61], NL: [5.3, 52.2], DK: [9.5, 56], GB: [-2, 53.5], RU: [55, 57], BH: [50.55, 26.07], SG: [103.82, 1.35], MT: [14.4, 35.9], PS: [34.4, 31.45], LB: [35.86, 33.9], QA: [51.2, 25.3], KW: [47.6, 29.3], BN: [114.7, 4.5], LU: [6.1, 49.8], CY: [33.2, 35] };
  const blocsOf = (iso) => BLOCS.filter((b) => b.members.includes(iso));
  return { BLOCS, C, SIDES, PIN, blocsOf };
})();
