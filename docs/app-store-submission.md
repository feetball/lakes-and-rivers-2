# App Store submission checklist

What is already done, and what still has to be clicked in
[App Store Connect](https://appstoreconnect.apple.com) (ASC) before
*Submit for Review*. Written 2026-10-07 for the first release (1.0.1).

## Already in place

- **Listing text** (version page, en-US). Written through NoMac:
  - subtitle, description, keywords and promotional text
  - support URL <https://txfloods.kuecker.us/support> and privacy policy URL
    <https://txfloods.kuecker.us/privacy> (both live)
  - category Weather and copyright "2026 Daniel Kuecker"

  Edit any of it in ASC; NoMac does not overwrite it later.
- **Export compliance**: `ITSAppUsesNonExemptEncryption = false` in Info.plist,
  so ASC does not ask per build.
- **Privacy manifest** (`ios/App/App/PrivacyInfo.xcprivacy`): declares Product
  Interaction, not linked to the user, not used for tracking, purpose Analytics.
- **Screenshots** (made 2026-10-07 from the 1.0.1 build at Apple's exact sizes,
  no alpha) are in `app-store-screenshots/` at the repo root. Git ignores that
  folder through `.git/info/exclude`, so it never reaches the public repo.
  Download it from the VS Code explorer (right-click → Download):
  - `iphone-6.3/`: 1206 × 2622, the size ASC's "iPhone with Dynamic Island
    (medium display)" slot accepts
  - `ipad-13-2064/`: 2064 × 2752, and `ipad-13/`: 2048 × 2732, for the
    "iPad 13″ display" slot (either size should work)
  - `iphone-6.9/`: 1320 × 2868 (rejected by the medium slot; kept in case a
    large-display slot appears)

  They are not uploaded yet. NoMac's review lint has one red finding left,
  "No screenshots uploaded". Upload them by hand: NoMac's bulk endpoint caps a
  request at 4 MiB, and its per-file route cannot get Apple's upload address
  for screenshots.

## Still to do in ASC, in this order

1. **Agreements, Tax, and Banking.** The *Paid Apps* agreement must be active,
   with bank and tax forms filled in, or a $0.99 price cannot be set.
2. **Version number.** The App Store version is still `1.0`, but the next build
   is `1.0.1`. ASC only attaches a build whose version matches, so on the
   version page change *1.0* to *1.0.1*. The listing text stays.
3. **Build 10.** Run this from the staged folder; it uses 1 of 50 NoMac attempts:

   ```sh
   cd /tmp/claude-0/-opt-lakes-and-rivers-2/65d725e0-05b9-4db1-aeb0-d0493a42d64f/scratchpad/b10/stage
   nomac push && nomac build --testflight
   ```

   Then try it on a phone:
   - Privacy and Support open in a sheet inside the app.
   - Landscape on a notched iPhone shows nothing under the notch.
   - The "Share anonymous usage stats" switch works.
4. **Screenshots.** On the version page, drag in:
   - the 6 files from `iphone-6.3/` under *iPhone with Dynamic Island*
   - the 6 files from `ipad-13-2064/` under *iPad 13″ display*

   Keep the numbered order.
5. **Build.** In the *Build* section of the version page, pick build 10 (1.0.1).
6. **App Privacy** (sidebar). Answer *Yes, we collect data*:
   - **Usage Data → Product Interaction**: purpose *Analytics*; not linked to
     the user's identity; not used for tracking.
   - Nothing else. Location is **not collected**, because it never leaves the
     device.
7. **Age Rating.** Answer *None* / *No* to everything. For *Unrestricted Web
   Access*, *No* fits: links open single pages (weather.gov, NOAA gauge pages,
   our policy) in a Safari sheet, not a browser. The result should be 4+.
8. **Content Rights** (App Information). *Yes, it contains third-party
   content, and I have the rights*: NOAA and USGS data are public domain, and
   the map data is OpenStreetMap, ODbL, credited on the map.
9. **Pricing and Availability.**
   - Price: US $0.99.
   - Availability: either exclude the EU storefronts, or finish the *EU Digital
     Services Act* trader status. As a trader, your address, phone and email
     are shown on the EU product page.
10. **App Review Information.**
    - Your name, phone and email.
    - *Sign-in required*: off.
    - Paste the notes below.
11. **Submit.** *Add for Review*, then *Submit to App Review*. Review usually
    takes 1–3 days.

## App Review notes (paste as is)

```
Texas Flood Map is an independent app that maps public river-gauge data for
Texas from the NOAA National Water Prediction Service and the U.S. Geological
Survey. It is not affiliated with any government agency; the first-launch
disclaimer, the gauge sheets and the description all say so. There is no
account or login.

Things to try:
1. Tap any colored dot for that gauge's detail: status, flood stages, the NWS
   forecast crest where one exists, and a 48-hour chart.
2. Drag the timeline at the bottom back up to 7 days, or press play.
3. Tap the list button (top right) for Favorites, Near me and Search. Near me
   asks for location only at that moment (When In Use).
4. In the legend, open "Layers" to show NWS flood warnings/watches and USGS
   river camera photos.

Native features: CoreLocation for the locate button and Near me; external
pages open in SFSafariViewController; the complete Texas river and lake map
is bundled in the app, and the last readings are saved on the device so the
map opens without a connection.

If no rivers are flooding when you review, most gauges are blue (normal).
That is expected; gray and tan gauges have no recent reading or no official
flood stages.

Privacy: location never leaves the device. The app sends anonymous usage
counts (app opened, gauge opened), which can be turned off in the legend.
Privacy policy: https://txfloods.kuecker.us/privacy
```

## If Apple rejects under 4.2 (minimum functionality)

Reply in ASC with the native features above. These were the review's
strongest arguments against "a repackaged website":
- the bundled river geometry
- offline readings
- CoreLocation
- the Safari sheet
- the timeline playback

Screenshots 2 and 4 (gauge detail, timeline) show the parts a website
wrapper would not have.
