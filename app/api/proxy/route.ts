// app/api/proxy/route.ts

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const targetUrl = searchParams.get('url')

  // Validación: Solo permitir URLs de la API de Google Maps
  if (!targetUrl || !targetUrl.startsWith('https://maps.googleapis.com')) {
    return new Response(JSON.stringify({ error: 'URL inválida o no permitida' }), {
      status: 400,
    })
  }

  try {
    const response = await fetch(targetUrl)
    const data = await response.json()
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('Error in proxy:', error)
    return new Response(JSON.stringify({ error: 'Failed to fetch data' }), {
      status: 500,
    })
  }
}
