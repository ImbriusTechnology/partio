// The demo library's CSV files, built into the app. Prices are illustrative, not current quotes.
import locations from './locations.csv?raw';
import parts from './parts.csv?raw';
import bom from './bom.csv?raw';
import sources from './sources.csv?raw';
import stock from './stock.csv?raw';

export const demoFiles = () => [
  { name: 'locations.csv', text: locations },
  { name: 'parts.csv', text: parts },
  { name: 'stock.csv', text: stock },
  { name: 'sources.csv', text: sources },
  { name: 'bom.csv', text: bom },
];
