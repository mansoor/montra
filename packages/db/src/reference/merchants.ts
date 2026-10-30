/**
 * Reference merchants (OPS-05): normalized match keys (see @montra/importers normalizeDescription), display
 * names and a category hint naming a default category of the personal chart. Versioned; the loader upserts.
 */
export interface MerchantSeed {
  id: string;
  name: string;
  key: string;
  hint: string;
  mcc?: string;
}

const m = (id: string, name: string, key: string, hint: string, mcc?: string): MerchantSeed => ({
  id,
  name,
  key,
  hint,
  mcc,
});

export const MERCHANTS: MerchantSeed[] = [
  // Groceries
  m('trader-joes', "Trader Joe's", 'TRADER JOES', 'Groceries', '5411'),
  m('whole-foods', 'Whole Foods Market', 'WHOLE FOODS', 'Groceries', '5411'),
  m('safeway', 'Safeway', 'SAFEWAY', 'Groceries', '5411'),
  m('kroger', 'Kroger', 'KROGER', 'Groceries', '5411'),
  m('costco', 'Costco', 'COSTCO WHSE', 'Groceries', '5300'),
  m('costco-gas', 'Costco Gas', 'COSTCO GAS', 'Fuel & transport', '5542'),
  m('walmart', 'Walmart', 'WALMART', 'Groceries', '5310'),
  m('wal-mart', 'Walmart', 'WAL MART', 'Groceries', '5310'),
  m('target', 'Target', 'TARGET', 'Household', '5310'),
  m('aldi', 'Aldi', 'ALDI', 'Groceries', '5411'),
  m('publix', 'Publix', 'PUBLIX', 'Groceries', '5411'),
  m('heb', 'H-E-B', 'H E B', 'Groceries', '5411'),
  m('wegmans', 'Wegmans', 'WEGMANS', 'Groceries', '5411'),
  m('sprouts', 'Sprouts Farmers Market', 'SPROUTS', 'Groceries', '5411'),
  m('instacart', 'Instacart', 'INSTACART', 'Groceries', '5499'),
  m('rewe', 'REWE', 'REWE', 'Groceries', '5411'),
  m('tesco', 'Tesco', 'TESCO', 'Groceries', '5411'),
  m('carrefour', 'Carrefour', 'CB CARREFOUR', 'Groceries', '5411'),
  // Dining
  m('starbucks', 'Starbucks', 'STARBUCKS', 'Dining out', '5814'),
  m('blue-bottle', 'Blue Bottle Coffee', 'BLUE BOTTLE', 'Dining out', '5814'),
  m('peets', "Peet's Coffee", 'PEETS', 'Dining out', '5814'),
  m('dunkin', "Dunkin'", 'DUNKIN', 'Dining out', '5814'),
  m('mcdonalds', "McDonald's", 'MCDONALDS', 'Dining out', '5814'),
  m('chipotle', 'Chipotle', 'CHIPOTLE', 'Dining out', '5814'),
  m('subway', 'Subway', 'SUBWAY', 'Dining out', '5814'),
  m('pret', 'Pret A Manger', 'PRET A MANGER', 'Dining out', '5814'),
  m('doordash', 'DoorDash', 'DOORDASH', 'Dining out', '5812'),
  m('ubereats', 'Uber Eats', 'UBER EATS', 'Dining out', '5812'),
  m('grubhub', 'Grubhub', 'GRUBHUB', 'Dining out', '5812'),
  // Transport and fuel
  m('shell', 'Shell', 'SHELL OIL', 'Fuel & transport', '5541'),
  m('chevron', 'Chevron', 'CHEVRON', 'Fuel & transport', '5541'),
  m('exxon', 'ExxonMobil', 'EXXONMOBIL', 'Fuel & transport', '5541'),
  m('bp', 'BP', 'BP', 'Fuel & transport', '5541'),
  m('uber', 'Uber', 'UBER TRIP', 'Fuel & transport', '4121'),
  m('uber-plain', 'Uber', 'UBER', 'Fuel & transport', '4121'),
  m('lyft', 'Lyft', 'LYFT', 'Fuel & transport', '4121'),
  m('bart', 'BART', 'BART', 'Fuel & transport', '4111'),
  m('clipper', 'Clipper', 'CLIPPER', 'Fuel & transport', '4111'),
  // Subscriptions and digital
  m('netflix', 'Netflix', 'NETFLIX', 'Subscriptions', '4899'),
  m('netflix-com', 'Netflix', 'NETFLIX COM', 'Subscriptions', '4899'),
  m('spotify', 'Spotify', 'SPOTIFY', 'Subscriptions', '5815'),
  m('apple', 'Apple', 'APPLE', 'Subscriptions', '5818'),
  m('google', 'Google', 'GOOGLE', 'Subscriptions', '5818'),
  m('youtube', 'YouTube', 'YOUTUBE', 'Subscriptions', '5815'),
  m('hulu', 'Hulu', 'HULU', 'Subscriptions', '4899'),
  m('disney-plus', 'Disney+', 'DISNEY PLUS', 'Subscriptions', '4899'),
  m('amazon-prime', 'Amazon Prime', 'AMAZON PRIME', 'Subscriptions', '5968'),
  m('amazon', 'Amazon', 'AMAZON', 'Household', '5942'),
  m('microsoft', 'Microsoft', 'MICROSOFT', 'Subscriptions', '5734'),
  m('adobe', 'Adobe', 'ADOBE', 'Subscriptions', '5734'),
  m('dropbox', 'Dropbox', 'DROPBOX', 'Subscriptions', '5734'),
  // Utilities and phone
  m('pge', 'PG&E', 'PG&E', 'Utilities', '4900'),
  m('pge-alt', 'PG&E', 'PGANDE', 'Utilities', '4900'),
  m('con-ed', 'Con Edison', 'CON ED', 'Utilities', '4900'),
  m('comcast', 'Xfinity', 'COMCAST', 'Phone & internet', '4899'),
  m('xfinity', 'Xfinity', 'XFINITY', 'Phone & internet', '4899'),
  m('att', 'AT&T', 'AT&T', 'Phone & internet', '4814'),
  m('verizon', 'Verizon', 'VERIZON', 'Phone & internet', '4814'),
  m('tmobile', 'T-Mobile', 'T MOBILE', 'Phone & internet', '4814'),
  m('edf', 'EDF', 'PRLV SEPA EDF', 'Utilities', '4900'),
  // Household, electronics, clothing
  m('home-depot', 'The Home Depot', 'HOME DEPOT', 'Household', '5200'),
  m('lowes', "Lowe's", 'LOWES', 'Household', '5200'),
  m('ikea', 'IKEA', 'IKEA', 'Household', '5712'),
  m('bed-bath', 'Bed Bath & Beyond', 'BED BATH & BEYOND', 'Household', '5719'),
  m('best-buy', 'Best Buy', 'BEST BUY', 'Electronics', '5732'),
  m('apple-store', 'Apple Store', 'APPLE STORE', 'Electronics', '5732'),
  m('gap', 'Gap', 'GAP', 'Clothing', '5651'),
  m('old-navy', 'Old Navy', 'OLD NAVY', 'Clothing', '5651'),
  m('uniqlo', 'Uniqlo', 'UNIQLO', 'Clothing', '5651'),
  m('nordstrom', 'Nordstrom', 'NORDSTROM', 'Clothing', '5311'),
  m('tj-maxx', 'TJ Maxx', 'TJ MAXX', 'Clothing', '5651'),
  // Health and personal care
  m('cvs', 'CVS Pharmacy', 'CVS PHARMACY', 'Healthcare', '5912'),
  m('walgreens', 'Walgreens', 'WALGREENS', 'Healthcare', '5912'),
  m('rite-aid', 'Rite Aid', 'RITE AID', 'Healthcare', '5912'),
  m('sephora', 'Sephora', 'SEPHORA', 'Personal care', '5977'),
  // Entertainment and travel
  m('amc', 'AMC Theatres', 'AMC', 'Entertainment', '7832'),
  m('steam', 'Steam', 'STEAM', 'Entertainment', '5816'),
  m('delta', 'Delta Air Lines', 'DELTA AIR LINES', 'Travel', '3058'),
  m('united', 'United Airlines', 'UNITED', 'Travel', '3000'),
  m('southwest', 'Southwest Airlines', 'SOUTHWEST', 'Travel', '3066'),
  m('airbnb', 'Airbnb', 'AIRBNB', 'Travel', '7011'),
  m('marriott', 'Marriott', 'MARRIOTT', 'Travel', '3509'),
  m('expedia', 'Expedia', 'EXPEDIA', 'Travel', '4722'),
  // Insurance and giving
  m('geico', 'GEICO', 'GEICO', 'Insurance', '6300'),
  m('state-farm', 'State Farm', 'STATE FARM', 'Insurance', '6300'),
  m('progressive', 'Progressive', 'PROGRESSIVE', 'Insurance', '6300'),
  m('red-cross', 'American Red Cross', 'AMERICAN RED CROSS', 'Gifts & donations', '8398'),
];
