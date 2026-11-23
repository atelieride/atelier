// A paired phone on screen: the name it gave, or its model's marketing name when iOS only says "iPhone". Loaded with
// Settings › iPhone and the pairing sheet, and with the marks once iPhone access is on (the footer pill's tooltip):
// never in the first paint. Pure.

/** The marketing names of the iPhones Atelier's app runs on (iOS 18 and later), by hardware model. */
const MODELS: Record<string, string> = {
  'iPhone11,2': 'iPhone XS', 'iPhone11,4': 'iPhone XS Max', 'iPhone11,6': 'iPhone XS Max', 'iPhone11,8': 'iPhone XR',
  'iPhone12,1': 'iPhone 11', 'iPhone12,3': 'iPhone 11 Pro', 'iPhone12,5': 'iPhone 11 Pro Max', 'iPhone12,8': 'iPhone SE',
  'iPhone13,1': 'iPhone 12 mini', 'iPhone13,2': 'iPhone 12', 'iPhone13,3': 'iPhone 12 Pro', 'iPhone13,4': 'iPhone 12 Pro Max',
  'iPhone14,4': 'iPhone 13 mini', 'iPhone14,5': 'iPhone 13', 'iPhone14,2': 'iPhone 13 Pro', 'iPhone14,3': 'iPhone 13 Pro Max',
  'iPhone14,6': 'iPhone SE', 'iPhone14,7': 'iPhone 14', 'iPhone14,8': 'iPhone 14 Plus', 'iPhone15,2': 'iPhone 14 Pro',
  'iPhone15,3': 'iPhone 14 Pro Max', 'iPhone15,4': 'iPhone 15', 'iPhone15,5': 'iPhone 15 Plus', 'iPhone16,1': 'iPhone 15 Pro',
  'iPhone16,2': 'iPhone 15 Pro Max', 'iPhone17,3': 'iPhone 16', 'iPhone17,4': 'iPhone 16 Plus', 'iPhone17,1': 'iPhone 16 Pro',
  'iPhone17,2': 'iPhone 16 Pro Max', 'iPhone17,5': 'iPhone 16e', 'iPhone18,3': 'iPhone 17', 'iPhone18,4': 'iPhone Air',
  'iPhone18,1': 'iPhone 17 Pro', 'iPhone18,2': 'iPhone 17 Pro Max'
};

/** "iPhone 16 Pro" for iPhone17,1; an unknown model by its family (iPhone, iPad), else as reported. */
export function modelName(model: string): string {
  const known = MODELS[model];
  if (known) return known;
  const family = /^(iPhone|iPad|iPod)\d/.exec(model)?.[1];
  return family ?? (model.trim() || 'iPhone');
}

/** The names iOS gives every device unless the user's own name is allowed: they say less than the model. */
const GENERIC = /^(iphone|ipad|ipod touch)$/i;

/** What a phone is called on screen: the name it gave, or its model when that name is only "iPhone". */
export function deviceTitle(d: { name: string; model: string }): string {
  const name = d.name.trim();
  return name && !GENERIC.test(name) ? name : modelName(d.model);
}

/** The second line under a phone's title: its model, unless the title already is the model. */
export function deviceSubtitle(d: { name: string; model: string }): string | null {
  const model = modelName(d.model);
  return deviceTitle(d) === model ? null : model;
}
