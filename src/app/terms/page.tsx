import type { Metadata } from 'next';
import Link from 'next/link';
import InfoPage from '@/components/InfoPage';

// Linked from the app (disclaimer, legend), /support and /privacy. DRAFT written without a
// lawyer: have an attorney read it before relying on it. Keep it consistent with
// DisclaimerModal.tsx, /privacy and the store listings, and bump the date (and the
// disclaimer's STORAGE_KEY, so people see it again) when the substance changes.

export const metadata: Metadata = {
  title: 'Terms of use · Texas Flood Map',
  description: 'The terms for using the Texas Flood Map app and website, and where its data comes from.',
};

export default function TermsPage() {
  return (
    <InfoPage title="Terms of use" updated="October 15, 2026">
      <p>
        These terms cover the Texas Flood Map app and the website at txfloods.kuecker.us. Texas
        Flood Map is an independent project by Daniel Kuecker (&ldquo;we&rdquo;, &ldquo;us&rdquo;).
        By using the app or the website you agree to these terms. If you do not agree, do not use
        them.
      </p>

      <h2>Not an official warning service</h2>
      <ul>
        <li>
          Texas Flood Map shows public data for general information. Use it as a supplement,
          never as your only source, and never as the only basis for a decision about your
          safety or anyone else&apos;s.
        </li>
        <li>
          Gauge readings, flood categories, forecasts, warnings and camera photos shown here can
          be late, wrong or missing, and the app or the website can stop working at any time,
          including during a flood.
        </li>
        <li>
          In an emergency call 911. Follow the instructions of local officials and the official
          warnings from the <a href="https://www.weather.gov/">National Weather Service</a>. Never
          drive or walk into flood water.
        </li>
      </ul>

      <h2>Where the data comes from</h2>
      <p>
        We do not measure anything ourselves. The app shows public data from these sources; we
        combine and display the readings but do not change them:
      </p>
      <ul>
        <li>
          River and lake gauge readings, flood stages and forecasts: the NOAA{' '}
          <a href="https://water.noaa.gov/">National Water Prediction Service</a> of the National
          Weather Service, which includes gauges run by the U.S. Geological Survey and partner
          agencies. When that service is unavailable, readings come directly from{' '}
          <a href="https://waterdata.usgs.gov/">USGS Water Data</a>.
        </li>
        <li>
          Flood warnings and watches: the National Weather Service (
          <a href="https://www.weather.gov/documentation/services-web-api">api.weather.gov</a>).
        </li>
        <li>River camera photos: the U.S. Geological Survey.</li>
        <li>
          Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>{' '}
          contributors, served as <a href="https://protomaps.com/">Protomaps</a> vector tiles.
        </li>
      </ul>
      <p>
        Real-time gauge data is <strong>provisional</strong>: the agencies publish it before it is
        reviewed and may revise it later. A gauge&apos;s details show when its reading was taken
        and where it came from, and a reading too old to stand for current conditions is shown
        gray on the map, not as a status. Flood categories compare a reading with the flood stages the National
        Weather Service publishes for that gauge; many gauges have none.
      </p>
      <p>
        Texas Flood Map is not affiliated with or endorsed by NOAA, the National Weather Service,
        the U.S. Geological Survey or any government agency.
      </p>

      <h2>No warranty</h2>
      <p>
        The app and the website are provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;.
        To the fullest extent the law allows, we make no warranties of any kind, express or
        implied, including that the data is accurate, complete or current, that the service will
        be available or free of errors, or that it is fit for any particular purpose.
      </p>

      <h2>Limits on our liability</h2>
      <p>
        To the fullest extent the law allows, we are not liable for any loss, damage or injury
        that results from using or relying on the app, the website or the data they show, or from
        their being unavailable, late or wrong. That includes indirect, incidental, special and
        consequential damages. If we are found liable anyway, our total liability is limited to
        the amount you paid for the app. Some laws do not allow some of these limits; where they
        do not, the limits apply only as far as the law allows.
      </p>

      <h2>Buying the app</h2>
      <p>
        The app is sold through Apple&apos;s App Store and Google Play. Payment, refunds and family
        sharing follow the store&apos;s own terms. If you got the app from the App Store,
        Apple&apos;s standard Licensed Application End User License Agreement also applies, and
        these terms add to it.
      </p>

      <h2>Fair use of the service</h2>
      <p>
        Do not overload or interfere with our servers (for example with automated bulk requests),
        and do not present what the app shows as an official warning or as coming from us or a
        government agency.
      </p>

      <h2>Changes and law</h2>
      <p>
        We may update these terms; the date at the top shows the latest version, and using the app
        or the website after a change means you accept it. These terms are governed by the laws of
        the State of Texas. Your privacy is covered by the{' '}
        <Link href="/privacy">privacy policy</Link>. Questions: see{' '}
        <Link href="/support">support</Link>.
      </p>
    </InfoPage>
  );
}
