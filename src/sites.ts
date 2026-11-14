export interface Site {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}

// Centres of the areas used by the full Invisible Earth application.
export const sites: readonly Site[] = [
  { id: 'venezuela', name: 'Venezuela', latitude: 10.7, longitude: -68.05 },
  { id: 'granada', name: 'Granada', latitude: 37.11, longitude: -3.55 },
  { id: 'mexico', name: 'Mexico City', latitude: 19.385, longitude: -99.075 },
  { id: 'nepal', name: 'Nepal · Tibet', latitude: 28.2, longitude: 85.35 },
  { id: 'krasheninnikov', name: 'Krasheninnikov', latitude: 54.59, longitude: 160.26 },
];
