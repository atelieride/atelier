// Sidebar drags between places (a workspace's own tabs, its activities): what each drop target takes. Pure.

/** A sidebar row dragged onto a place carries its terminal id under this type. */
export const ROW_MIME = 'application/x-atelier-terminal';
/** An activity's head dragged onto another workspace's head carries the activity's id under this type. */
export const ACT_MIME = 'application/x-atelier-ws-activity';
/**
 * …and the place it comes from under this one (types are all a drag over shows, lowercased): a row's place, an
 * activity's workspace. No drop state where it already is.
 */
export const fromType = (placeId: string): string => `application/x-atelier-from-${placeId.toLowerCase()}`;

/** A drop target: a workspace's head, its own rows' zone, or an activity (its head, and its band when open). */
export interface PlaceTarget { id: string; kind: 'workspace' | 'own' | 'activity' }

/**
 * What a drag with these types does on `target`: 'row' moves a row there, 'activity' moves a whole activity to that
 * workspace (only onto another workspace's head: activities never go into activities); null: no drop here.
 */
export function placeDrop(types: readonly string[], target: PlaceTarget): 'row' | 'activity' | null {
  const away = !types.includes(fromType(target.id));
  if (types.includes(ACT_MIME)) return target.kind === 'workspace' && away ? 'activity' : null;
  return types.includes(ROW_MIME) && away ? 'row' : null;
}
