'use client';

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  FAVORITES_LIMIT,
  getFavorites,
  isFavorite as isStarred,
  isFavoritesPersistent,
  onFavoritesChange,
  toggleFavorite,
} from '@/lib/favorites';

export type ToggleResult = 'added' | 'removed' | 'limit';

const NONE: readonly string[] = Object.freeze([]);
const subscribe = (notify: () => void) => onFavoritesChange(() => notify());

// React view of src/lib/favorites.ts: re-renders on a change made anywhere (this tab,
// another tab, another component). The list is empty on the server render.
export function useFavorites() {
  const favorites = useSyncExternalStore(subscribe, getFavorites, () => NONE);
  const starred = useMemo(() => new Set(favorites), [favorites]);
  const isFavorite = useCallback((id: string) => starred.has(id.trim().toUpperCase()), [starred]);
  const toggle = useCallback((id: string): ToggleResult => {
    const was = isStarred(id);
    const now = toggleFavorite(id);
    return was ? 'removed' : now ? 'added' : 'limit';
  }, []);
  return { favorites, isFavorite, toggle, limit: FAVORITES_LIMIT, persistent: isFavoritesPersistent() };
}
