import { Loader } from '@googlemaps/js-api-loader'

let loader: Loader | null = null

export function getMapsLoader() {
  if (!loader) {
    loader = new Loader({
      apiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY!, // ya la tenés
      libraries: ['places'],
      region: 'NI',
      language: 'es',
    })
  }
  return loader
}
