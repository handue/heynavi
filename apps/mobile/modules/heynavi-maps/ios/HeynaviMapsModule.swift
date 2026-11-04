import CoreLocation
import ExpoModulesCore
import MapKit

/// Apple MapKit on the phone (ARCHITECTURE 8): place search, walking routes and the street the
/// user is on. No API key or account. Coordinates go only to Apple, never to HeyNavi's backend.
public class HeynaviMapsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HeynaviMaps")

    /// Places matching `query` around a point, as MapKit returns them (the app sorts by distance).
    AsyncFunction("searchPlaces") { (query: String, latitude: Double, longitude: Double, radiusMeters: Double) async throws -> [[String: Any]] in
      let request = MKLocalSearch.Request()
      request.naturalLanguageQuery = query
      request.region = MKCoordinateRegion(
        center: CLLocationCoordinate2D(latitude: latitude, longitude: longitude),
        latitudinalMeters: radiusMeters * 2,
        longitudinalMeters: radiusMeters * 2
      )
      request.resultTypes = [.pointOfInterest, .address]
      // Only places inside the region: as a hint, MapKit returned same-name places in other cities
      // first and the nearby one not at all (outdoor test, 2026-11-03).
      if #available(iOS 18.0, *) {
        request.regionPriority = .required
      }
      let response = try await MKLocalSearch(request: request).start()
      return response.mapItems.map { item in
        let coordinate = item.placemark.coordinate
        return [
          "name": item.name ?? item.placemark.title ?? query,
          "address": item.placemark.title ?? "",
          "latitude": coordinate.latitude,
          "longitude": coordinate.longitude,
        ]
      }
    }

    /// The first walking route between two points: its length, expected time, and its steps, each
    /// with MapKit's instruction for the start of the step and the step's own line.
    AsyncFunction("walkingRoute") { (fromLatitude: Double, fromLongitude: Double, toLatitude: Double, toLongitude: Double) async throws -> [String: Any] in
      let request = MKDirections.Request()
      request.source = MKMapItem(placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(latitude: fromLatitude, longitude: fromLongitude)))
      request.destination = MKMapItem(placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(latitude: toLatitude, longitude: toLongitude)))
      request.transportType = .walking
      request.requestsAlternateRoutes = false
      let response = try await MKDirections(request: request).calculate()
      guard let route = response.routes.first else {
        throw Exception(name: "NoRoute", description: "MapKit found no walking route")
      }
      return [
        "distance": route.distance,
        "expectedTravelTime": route.expectedTravelTime,
        "steps": route.steps.map { step in
          [
            "instructions": step.instructions,
            "notice": step.notice ?? "",
            "distance": step.distance,
            "points": Self.points(step.polyline),
          ] as [String: Any]
        },
      ]
    }

    /// The street and area at a point, in English, for "where am I".
    AsyncFunction("reverseGeocode") { (latitude: Double, longitude: Double) async throws -> [String: Any] in
      let placemarks = try await CLGeocoder().reverseGeocodeLocation(
        CLLocation(latitude: latitude, longitude: longitude),
        preferredLocale: Locale(identifier: "en_US")
      )
      guard let place = placemarks.first else { return [:] }
      return [
        "name": place.name ?? "",
        "street": place.thoroughfare ?? "",
        "area": place.subLocality ?? "",
        "city": place.locality ?? "",
      ]
    }
  }

  private static func points(_ polyline: MKPolyline) -> [[Double]] {
    var coordinates = [CLLocationCoordinate2D](repeating: kCLLocationCoordinate2DInvalid, count: polyline.pointCount)
    polyline.getCoordinates(&coordinates, range: NSRange(location: 0, length: polyline.pointCount))
    return coordinates.map { [$0.latitude, $0.longitude] }
  }
}
