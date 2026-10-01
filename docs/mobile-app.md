# Building and shipping the iOS and Android apps

This guide is for whoever compiles and uploads the apps (it assumes a Mac,
a terminal, and no prior Xcode or Android Studio experience). The business
side — what the data costs and where it comes from — is in
[mobile-data-strategy.md](mobile-data-strategy.md).

## How the app is put together

The map you see on the website *is* the app. [Capacitor](https://capacitorjs.com)
wraps the compiled web app in a native shell: a real iOS app (Swift, Xcode
project in `ios/`) and a real Android app (Kotlin/Gradle project in
`android/`) whose one screen is a full-bleed web view loading the bundle
from inside the app binary. Everything the website can do, the app does, and
the same source builds all three.

What the apps do beyond the website:

| | Website | App |
| --- | --- | --- |
| River/lake geometry (17 MB) | downloaded on first visit | **inside the app binary**, no download |
| Live gauge readings | polled from same-origin `/api/gauges` | polled from the hosted API (`NEXT_PUBLIC_API_BASE`) |
| Last-known readings when offline | — | **shown, with their timestamp**, plus a "can't reach the server" notice |
| Locate me | — | **native location button** (top-right) |
| Android back button | — | closes the gauge sheet, then backgrounds the app |
| Admin login in the legend | yes | hidden |

The app has no server of its own. The Cloudflare Worker deployment of this
repo is the backend (see [deploying-to-cloudflare.md](deploying-to-cloudflare.md));
its address is baked into the app at build time.

## One-time setup on the Mac

1. **Xcode 26 or newer** from the Mac App Store (Capacitor 8 requires ≥ 26.0).
   Open it once so it installs its components, then in a terminal:

   ```bash
   xcode-select --install          # command-line tools (safe if already present)
   sudo xcodebuild -license accept
   ```

   In Xcode → Settings → Components, make sure an **iOS Simulator** runtime is
   downloaded. CocoaPods is *not* needed — the project uses Swift Package
   Manager.

2. **Node 22 and pnpm** — install Node from [nodejs.org](https://nodejs.org)
   (or `brew install node@22`), then:

   ```bash
   corepack enable                 # activates the pnpm version pinned in package.json
   ```

3. **Clone and install**:

   ```bash
   git clone <repo url> texas-flood-map
   cd texas-flood-map
   pnpm install
   ```

4. **Android Studio** (only for the Android app) — download from
   [developer.android.com/studio](https://developer.android.com/studio);
   Capacitor 8 needs **2025.2.1 or newer**. On first launch let it install the
   default SDK, then in *SDK Manager* make sure **Android SDK Platform 36** is
   installed. It bundles its own JDK, so nothing else to install.

## Building

```bash
pnpm mobile:build        # 1) builds public/data (first time ~2 min, then cached)
                         # 2) static export of the web app into out/
                         # 3) `cap sync` — copies out/ into ios/ and android/
pnpm mobile:ios          # opens the Xcode project
pnpm mobile:android      # opens the Android Studio project
```

Run `pnpm mobile:build` again after **any** change to the web code; the native
projects only see what was last synced. Other commands:

| Command | What it does |
| --- | --- |
| `pnpm mobile:export` | export only, no sync |
| `pnpm mobile:sync` | sync only (after editing `capacitor.config.ts` or adding a plugin) |
| `pnpm mobile:assets` | regenerate every icon/splash size from `resources/` (see *Icon*) |

Build-time overrides (all optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| `MOBILE_API_BASE` | the Worker's `workers.dev` URL (see `next.config.mjs`) | where the app fetches gauge data. **Use a domain you own before shipping** — this value is frozen into every installed copy. |
| `NEXT_PUBLIC_TILE_URL` | OpenStreetMap | basemap tile URL template. **Must be changed for the store builds** — see the tiles section of [mobile-data-strategy.md](mobile-data-strategy.md). |
| `NEXT_PUBLIC_TILE_ATTRIBUTION` | OSM credit | attribution HTML for the tile provider |

Example of a release build against a custom domain and a paid tile provider:

```bash
MOBILE_API_BASE=https://api.example.com \
NEXT_PUBLIC_TILE_URL='https://tiles.stadiamaps.com/tiles/osm_bright/{z}/{x}/{y}.png?api_key=…' \
NEXT_PUBLIC_TILE_ATTRIBUTION='&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' \
pnpm mobile:build
```

### Running it on the iOS Simulator

In Xcode pick a simulator from the device menu next to the ▶ button and press
**⌘R**. First build takes a few minutes while Swift Package Manager downloads
Capacitor (needs internet; if you see "No such module Capacitor", use
File → Packages → Resolve Package Versions).

To debug the web layer: open Safari → Develop → *Simulator* → *Texas Flood
Map*. That's the same web inspector as the website. (Enable Safari's Develop
menu in Safari → Settings → Advanced.)

### Running on a real iPhone

Plug the phone in, trust the computer, pick the phone in the device menu,
and press ⌘R. The first time, Xcode needs a signing team (next section) and
the phone needs Developer Mode on (Settings → Privacy & Security).

## Accounts, signing and ownership

The **owner** of the app on both stores should be the person who is selling
it — the store account is where the money goes and where the legal
agreements are signed. The person compiling can be added as a team member.

- **Apple**: enrol the owner in the
  [Apple Developer Program](https://developer.apple.com/programs/enroll/)
  (US $99/year, allow a couple of days). Then in
  [App Store Connect](https://appstoreconnect.apple.com) → *Users and Access*,
  invite the builder's Apple ID with the **App Manager** role. In Xcode, the
  builder signs in with that Apple ID (Xcode → Settings → Accounts) and picks
  the team under *Signing & Capabilities* with **Automatically manage signing**
  checked. Xcode registers the bundle ID and creates certificates itself.
- **Google**: create a [Play Console](https://play.google.com/console)
  developer account for the owner (US $25 once). Invite the builder under
  *Users and permissions*. **Personal (non-organisation) accounts created since
  late 2023 must run a closed test with at least 12 testers for 14 days
  before they are allowed to publish to production** — plan for this; it is
  the slowest step of the whole process.

The identifiers already set (change them *before* the first upload if you
want different ones — they're permanent afterwards):

| | Value | Where |
| --- | --- | --- |
| Bundle ID / application ID | `com.texasfloodmap.app` | `capacitor.config.ts` (source of truth), mirrored in the Xcode project and `android/app/build.gradle` |
| Display name | Texas Flood Map | same |

## Releasing on the App Store

1. **Versions.** In Xcode select the *App* target → *General*: **Version**
   (e.g. `1.0.0`, what users see) and **Build** (an integer that must go up on
   every upload, e.g. `1`, `2`, `3`…). These are `MARKETING_VERSION` and
   `CURRENT_PROJECT_VERSION` in the project file.
2. **Archive.** Set the device menu to *Any iOS Device (arm64)*, then
   Product → **Archive**. When the Organizer window opens: *Distribute App* →
   *App Store Connect* → *Upload*, accept the defaults. Uploads take a few
   minutes to process; you get an email.
3. **Create the app record** (first time only) in App Store Connect →
   *Apps* → **+**: platform iOS, name *Texas Flood Map*, primary language,
   bundle ID `com.texasfloodmap.app`, SKU anything (e.g. `texasfloodmap`).
4. **TestFlight.** The uploaded build appears under the app's *TestFlight*
   tab. Add yourselves as internal testers and install the TestFlight app on
   your phones — this is how you test the real, signed build before review.
5. **Store listing**, under *App Store* → the version:
   - **Screenshots**: required for 6.9″ iPhones (1320 × 2868 px). Take them
     in the iPhone 16 Pro Max simulator (⌘S saves a PNG). If the app is
     available on iPad (it is by default), 13″ iPad screenshots
     (2064 × 2752) are needed too — or restrict to iPhone by setting the
     target's *Supported Destinations* to iPhone only.
   - Description, keywords, a **support URL** and a **privacy policy URL**
     (both mandatory; a page on the website is fine — the policy should say the
     app shows public NOAA/USGS data, uses location only on-device, and sends
     anonymous usage events (screen opened, gauge opened) with no account or
     identifier).
   - Category: *Weather*. Age rating: answer the questionnaire (results in 4+).
   - **Pricing**: *Pricing and Availability* → base price **US $0.99** (Apple
     sets equivalent prices in other countries automatically). Availability:
     all countries is fine, or just the US.
   - **App Privacy** questionnaire: declare *Usage Data → Product Interaction*,
     collected, **not** linked to the user, purpose *Analytics*. Nothing else
     is collected (location never leaves the phone). See the tracking notes
     in [mobile-data-strategy.md](mobile-data-strategy.md).
6. **Review notes** (in the version's *App Review Information*): say that it's
   an independent app displaying public NOAA National Water Prediction
   Service and USGS gauge data, not affiliated with any agency (the in-app
   disclaimer says so too), that no login exists, and that the timeline
   slider and locate button are the things worth trying. Reviews usually
   take 1–3 days.
7. **Submit for Review**, then *Release this version* automatically or by
   hand once approved.

Every later release: bump Version/Build, `pnpm mobile:build`, Archive,
Upload, add the build to a new version in App Store Connect, submit.

## Releasing on Google Play

1. **Open the project**: `pnpm mobile:android` (or Android Studio → Open →
   the `android/` folder). Let Gradle sync finish (first time downloads a lot).
2. **Test** on the emulator (Device Manager → create a Pixel with API 36 → ▶)
   or a phone with USB debugging on.
3. **Versions.** In `android/app/build.gradle`: `versionCode` (integer, must
   increase every upload) and `versionName` (what users see).
4. **Signing key.** Build → *Generate Signed App Bundle / APK* → *Android
   App Bundle* → *Create new…* keystore. Store the `.jks` file and both
   passwords somewhere safe (a password manager) — **losing it means never
   being able to update the app** unless Play App Signing is on, which the
   console offers during the first upload; accept it.
5. **Build the bundle** (release, `.aab`). It lands in
   `android/app/release/` or the path the dialog shows.
6. **Play Console** → *Create app*: name, default language, **App** (not
   game), **Paid**. Note: a paid app can later become free, but a free app
   can never become paid.
7. Work through the *Dashboard* checklist: privacy policy URL, app access
   (no login), ads (none), content rating questionnaire, target audience,
   **Data safety** form (data collected: *App interactions*, not shared, not
   optional, purpose analytics; location: **not collected**), store listing
   (screenshots of a phone, a 1024 × 500 feature graphic, icon 512 × 512 —
   `resources/icon-512.png` is exactly that), pricing **US $0.99**.
8. **Testing track first**: *Testing → Closed testing* → create a release,
   upload the `.aab`, add testers by email. Personal accounts must keep 12+
   testers opted in for 14 days (see above) before *Production* unlocks.
9. **Production**: create a release, upload, roll out. Review takes hours to
   a few days.

## Icon and splash screen

The placeholder icon is `resources/icon.svg`. To replace it: edit or swap
the SVG (keep the artwork inside the central two-thirds — Android masks the
edges into a circle/squircle), then:

```bash
node scripts/render-icon-sources.mjs   # SVG → the PNG sources in resources/
pnpm mobile:assets                     # PNGs → every iOS/Android size
```

Both are already committed for the current icon, so this only matters when
the artwork changes. If you have a finished 1024 × 1024 PNG from a designer,
drop it in as `resources/icon.png` and `resources/icon-foreground.png`
(same file) and just run `pnpm mobile:assets`.

## Where things live

| Path | What |
| --- | --- |
| `capacitor.config.ts` | app id, name, `webDir`, user-agent, web-view settings |
| `scripts/build-mobile.mjs` | the export build (`pnpm mobile:build`) |
| `src/lib/api.ts` | `apiUrl()`, `IS_MOBILE`, tile URL — the constants that differ between web and app builds |
| `src/components/LocateButton.tsx` | the locate-me control |
| `src/hooks/useGaugeData.ts` | fetching + the offline last-snapshot cache |
| `ios/App/App/Info.plist` | iOS permissions strings, orientation, export-compliance flag |
| `ios/App/App.xcodeproj` | version/build numbers, signing team |
| `android/app/build.gradle` | `versionCode` / `versionName`, application id |
| `android/app/src/main/AndroidManifest.xml` | Android permissions |
| `resources/` | icon/splash sources |
| `out/` (git-ignored) | the static export `cap sync` copies into the native projects |

Never edit `ios/App/App/public` or `android/app/src/main/assets/public` by
hand — they're overwritten on every sync.

## Troubleshooting

- **"No such module Capacitor" / red imports in Xcode** — Swift packages
  haven't resolved. File → Packages → *Resolve Package Versions* (needs
  internet). If `node_modules` was reinstalled, run `pnpm mobile:sync` first:
  the package paths in `ios/App/CapApp-SPM/Package.swift` point into it.
- **Signing errors** — no team selected, or the bundle ID is taken by another
  account. Pick the team under *Signing & Capabilities*; change the id in
  `capacitor.config.ts` + Xcode + `build.gradle` if it's taken.
- **Blank dark screen after launch** — the web bundle wasn't synced. Run
  `pnpm mobile:build` and rebuild. Safari's web inspector (above) shows the
  actual error.
- **Map draws but rivers stay gray / "Can't reach the server" notice** — the
  app can't reach `NEXT_PUBLIC_API_BASE`. Check the URL in a browser; make
  sure the Worker was deployed from this branch or later (it adds the CORS
  headers the app needs — `pnpm cf:deploy`). With no signal the notice is
  expected; the map shows the last snapshot.
- **Location button says "permission denied"** — on the simulator use
  Features → Location → *Custom Location…* and reset permissions with
  Device → *Erase All Content and Settings* if you denied it once.
- **Android: "SDK location not found"** — open the project in Android Studio
  once (it writes `android/local.properties`), or set `ANDROID_HOME`.
- **Android build fails after adding a plugin** — `pnpm mobile:sync`, then
  File → *Sync Project with Gradle Files*.
- **App Store rejection "4.2 Minimum Functionality"** — reviewers sometimes
  flag apps that look like wrapped websites. The reply that addresses it: the
  app bundles the full river/lake geometry offline, keeps the last readings
  available without a connection, uses native location, and is a
  purpose-built single-screen tool, not a browser around a site. Screenshots
  showing the timeline and gauge detail sheet help.
