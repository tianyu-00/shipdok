// The ways an app can be built, as the cards of the second step of creating one. A method that is not built yet is shown as "coming soon".
// Shipdok does not look inside the repository to guess which one fits: the person chooses, and Railpack (which needs nothing from the repository) is the default.

export const DEFAULT_METHOD = 'railpack'

export const METHOD_CARDS = [
  { id: 'dockerfile', title: 'Dockerfile', available: true, text: 'Builds the Dockerfile in your repository, so you decide exactly how the image is made.' },
  { id: 'railpack', title: 'Railpack', available: true, text: 'No Dockerfile needed. It looks at your code (Node, Python, Go, PHP, Ruby, Java, Rust and more), works out how to build it, and builds that.' },
  { id: 'nixpacks', title: 'Nixpacks', available: false, text: 'Another way to build straight from your code, without a Dockerfile.' },
  { id: 'static', title: 'Static site', available: false, text: 'Serves plain HTML, CSS and JavaScript files with a small web server. No build and no port to choose.' },
]

export const cardFor = (id) => METHOD_CARDS.find((c) => c.id === id) ?? null
