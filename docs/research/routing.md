# Walking routes for the navigation milestone

Checked 2026-10-29, for the Destination Navigation milestone (PLAN M5). The question: which real routing provider can give **walking** routes without blocking on an account or key.

## Measured from the development Mac (2026-10-29)

Same pair of public landmarks for both providers: Seoul City Hall (37.5663, 126.9779) to Gwanghwamun Square (37.5725, 126.9769). No personal location was used.

| Provider | Call | Result |
|---|---|---|
| **Apple MapKit** (`MKDirections`, `transportType = .walking`), from a Swift script on macOS 27.2 | Walking route | 1 route, **756 m**, 643 s expected, **320 ms**. 6 steps with English instructions: "Take a right", "Take a left", "Take a right onto Sejong-daero", "Continue onto 광화문광장", "The destination is on your left" |
| **Apple MapKit** (`MKLocalSearch`), 1.5 km region around City Hall | Place search | "pharmacy" 6 results, "Starbucks" 12, "subway station" 25, "Gwanghwamun Square" 1; **200–320 ms** each; English names. Results are not sorted by distance (a "Hongje Station" Starbucks came back), so the app must sort them itself |
| **OSRM foot profile**, FOSSGIS public server `routing.openstreetmap.de/routed-foot` (OpenStreetMap data) | Walking route | 1 route, **897 m**, 717 s, 0.69 s round trip. 8 steps as structured maneuvers (depart, turn left/right, arrive) with street names when OSM has them |

Both providers returned a usable walking route for this pair. A single pair says nothing about route quality across the city; we have to walk the demo route ourselves before relying on it.

## What the sources say

- **Google** does not offer walking or driving directions in South Korea because of the country's map-data export rules. A February 2026 government decision may allow it later, but no source confirms that the Routes API supports walking in Korea today. Not usable.
- **Apple Maps** offers walking routes in Korea without official Korean (NGII) data, according to press and Wikipedia (2025). The quality is described as uneven.
- **TMAP** (SK) has a pedestrian route API with the best Korean data. It needs an SK Open API account and app key, and the free quota for the pedestrian endpoint is not published. Only worth it if the user wants to set up that account.
- **Kakao and Naver** route APIs do not offer pedestrian routing, according to a developer blog.

## Decision for the plan

1. **Primary: Apple MapKit on the phone.** A small local Expo module (Swift) exposes `MKLocalSearch` and `MKDirections` walking routes. It needs no API key, no account and no paid Apple Developer membership, and it works in our Personal Team dev build. Coordinates go only to Apple, never to our backend.
2. **Fallback: OSRM foot profile through the backend.** It also needs no key. The FOSSGIS server is a public demo service meant for light use, which fits testing and a demo but not production.
3. **Optional: TMAP**, if the user creates an SK Open API key.

Sources:

- [Korea Herald: why Google Maps is still broken in South Korea](https://www.koreaherald.com/article/10487791)
- [Wikipedia: Map platforms in South Korea](https://en.wikipedia.org/wiki/Map_platforms_in_South_Korea)
- [Wikipedia: Restrictions on geographic data in South Korea](https://en.wikipedia.org/wiki/Restrictions_on_geographic_data_in_South_Korea)
- [The Star: Google Maps in South Korea (2025)](https://www.thestar.com.my/aseanplus/aseanplus-news/2025/05/18/why-google-maps-is-still-broken-in-south-korea-it-might-not-be-about-national-security-anymore)
- [velog: TMAP API pedestrian routing](https://velog.io/@ghenmaru/TMAP-TMAP-API-도보-길찾기)
- [TMAP transit API procedure](https://transit.tmapmobility.com/guide/procedure)
