// Storage locations. (Adding, renaming and removing them comes with the Locations screen.)
import { query } from './db.ts';

export interface Location {
  id: number; parent_id: number | null; name: string; path: string; code: string;
  description: string | null; archived: number; parts: number;
}

/** Locations in path order; archived ones only when asked for. */
export const listLocations = (includeArchived = false) => query<Location>(
  `SELECT l.*, (SELECT COUNT(*) FROM stock s WHERE s.location_id = l.id) AS parts FROM location l
   ${includeArchived ? '' : 'WHERE l.archived = 0'} ORDER BY l.path`);
