import type { Metadata } from 'next';
import Link from 'next/link';
import InfoPage from '@/components/InfoPage';

// Linked from the App Store / Google Play listings and from the app (legend, disclaimer).
// Every statement here must stay true of the code: the analytics are src/lib/track.ts +
// src/app/api/track/route.ts + src/lib/analytics-store.ts, location is src/lib/location.ts,
// and the iOS privacy manifest (ios/App/App/PrivacyInfo.xcprivacy) and the store privacy
// answers must match this page. Change them together and bump the date.

export const metadata: Metadata = {
  title: 'Privacy policy · Texas Flood Map',
  description: 'What the Texas Flood Map app and website collect, and what they do not.',
};

export default function PrivacyPage() {
  return (
    <InfoPage title="Privacy policy" updated="October 7, 2026">
      <p>
        This policy covers the Texas Flood Map app and the website at txfloods.kuecker.us. Texas
        Flood Map is an independent project; it is not affiliated with NOAA, the National Weather
        Service, USGS or any government agency.
      </p>

      <h2>The short version</h2>
      <ul>
        <li>There are no accounts. We never ask for your name, email address or phone number.</li>
        <li>Your location is used only on your device and is never sent to us.</li>
        <li>
          We count anonymous usage (how often the map and individual gauges are opened). You can
          switch this off in the app.
        </li>
        <li>
          No advertising, no third-party analytics or advertising code, no tracking across other
          apps or websites, and we do not sell or share data.
        </li>
      </ul>

      <h2>Anonymous usage statistics</h2>
      <p>To see which gauges people look at and whether the service is being used, the app sends two kinds of event to our server:</p>
      <ul>
        <li><strong>Map opened</strong>, once each time the app or website starts.</li>
        <li><strong>Gauge opened</strong>, with the ID of the river gauge you opened (for example a gauge on the Guadalupe River).</li>
      </ul>
      <p>
        Each event is stored with the time, and either the platform (iOS or Android app) or, for the
        website, the name of the site that linked to it. To count how many different people used the
        service on a given day, our server combines your IP address and your browser or app version
        string with a random key that changes every day, and keeps only a scrambled code (a one-way
        hash) made from them. Your IP address itself is not stored.
      </p>
      <p>
        <strong>How long we keep it:</strong> after each day ends, that day&apos;s events are
        combined into daily totals (counts of map opens, gauge opens and visitors) and the
        individual events are deleted, normally within an hour. The day&apos;s random key is
        deleted at the same time, so the scrambled codes can no longer be connected to anyone. The
        daily totals contain nothing about individual people and are kept.
      </p>
      <p>
        <strong>Turning it off:</strong> in the app or website, open the legend (the &ldquo;Flood
        status&rdquo; panel) and untick <strong>Share anonymous usage stats</strong>. Nothing is
        sent after that. The choice is remembered on your device.
      </p>

      <h2>Location</h2>
      <p>
        The app asks for your location only when you tap the locate button or open the
        &ldquo;Near me&rdquo; list, and only while you are using it. The position is used on your
        device to center the map and to sort gauges by distance. It is never sent to us or to
        anyone else, and the app never tracks your location in the background.
      </p>
      <p>
        Like any map, the app downloads map images (tiles) for the area on screen, so our map server
        receives requests for that area, but not your position. The app also remembers the last map
        view (center and zoom) on your device so it reopens where you left it.
      </p>
      <p>
        You can turn location access off at any time in your phone&apos;s settings. On iPhone, go to
        Settings &rarr; Privacy &amp; Security &rarr; Location Services &rarr; Texas Flood Map.
      </p>

      <h2>Stored on your device only</h2>
      <p>
        The app keeps these on your phone (in the web view&apos;s local storage) and never sends them
        to us: your favorite gauges, the last map view, which panels and layers you have open,
        whether you accepted the disclaimer, your usage-statistics choice, and the last gauge and
        warning data, so the map still shows something without a connection. Deleting the app
        removes all of it.
      </p>

      <h2>Servers and other services</h2>
      <p>
        Our gauge data and map servers run on Cloudflare. Like any web server, they receive your IP
        address and basic request details (such as the page requested and your app or browser
        version) in order to answer, and Cloudflare keeps short-lived request logs for operating and
        securing the service. See{' '}
        <a href="https://www.cloudflare.com/privacypolicy/">Cloudflare&apos;s privacy policy</a>.
      </p>
      <p>Some pictures and pages come straight from their public sources, which receive an ordinary web request from your device under their own privacy policies:</p>
      <ul>
        <li>Gauge graphs from the NOAA National Water Prediction Service (water.noaa.gov).</li>
        <li>River camera photos published by the U.S. Geological Survey (served from Amazon Web Services).</li>
        <li>OpenStreetMap map images, only if our own map server cannot be reached.</li>
        <li>Pages you choose to open, such as weather.gov or a gauge&apos;s NOAA page.</li>
      </ul>

      <h2>Children</h2>
      <p>
        The service is a general-audience map and is not directed at children under 13. It does not
        knowingly collect personal information from anyone.
      </p>

      <h2>Your choices and requests</h2>
      <p>
        You can switch off usage statistics and location access as described above. Because we do not
        keep anything that identifies you, we usually cannot find &ldquo;your&rdquo; data, but you
        are welcome to ask us any question about this policy.
      </p>

      <h2>Changes</h2>
      <p>
        If this policy changes, the new version will be posted here with a new date. If we ever start
        collecting something new, we will update this page before the app does it.
      </p>

      <h2>Contact</h2>
      <p>
        Questions or requests: see the <Link href="/support">support page</Link>.
      </p>
    </InfoPage>
  );
}
