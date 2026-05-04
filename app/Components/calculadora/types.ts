export type LatLng = google.maps.LatLngLiteral

export type PlaceLite = { label: string; lat: number; lng: number; ts: number }

export type Cotizacion = {
  id: string
  origen: string
  destino: string
  distanciaKm: number
  precioCordobas: number
  origenCoord?: LatLng
  destinoCoord?: LatLng
  createdAt?: Date | null
  fuente?: string
  zonaOrigen?: string | null
  zonaDestino?: string | null
}

export type PuntoComercio = {
  comercioUid: string
  comercioNombre: string
  puntoKey: string
  puntoNombre: string
  direccion: string
  coord: LatLng
  zonaRetiro: string | null
}

export type PuntoFavorito = {
  key: string
  label: string
  nombre?: string
  celular?: string
  direccion?: string
  coord?: LatLng
}

export type ZonasResult = {
  zonaRetiroNombre: string | null
  zonaEntregaNombre: string | null
  macroZonaRetiroNombre: string | null
  macroZonaEntregaNombre: string | null
} | null
