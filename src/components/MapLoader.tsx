'use client';

import dynamic from 'next/dynamic';
import { useEffect } from 'react';
import DisclaimerModal from './DisclaimerModal';
import { track } from '@/lib/track';

// Leaflet touches `window`, so render the map only on the client. The
// `ssr: false` dynamic import has to live in a Client Component under Next 15.
const MapView = dynamic(() => import('./MapView'), {
  ssr: false,
  loading: () => (
    <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: '#94a3b8' }}>
      Loading map…
    </div>
  ),
});

export default function MapLoader() {
  // One pageview beacon per app load. Empty deps → fires once on mount.
  useEffect(() => {
    track({ type: 'pageview' });
  }, []);

  return (
    <>
      <MapView />
      <DisclaimerModal />
    </>
  );
}
