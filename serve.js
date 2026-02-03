// Simple static file server for three-quake using Bun

const PORT = process.env.PORT || 8080;

const MIME_TYPES = {
	'.html': 'text/html',
	'.js': 'application/javascript',
	'.mjs': 'application/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.wav': 'audio/wav',
	'.mp3': 'audio/mpeg',
	'.ogg': 'audio/ogg',
	'.pak': 'application/octet-stream',
	'.bsp': 'application/octet-stream',
	'.mdl': 'application/octet-stream',
	'.wad': 'application/octet-stream',
	'.lmp': 'application/octet-stream',
	'.dem': 'application/octet-stream',
};

function getMimeType( path ) {

	const ext = path.substring( path.lastIndexOf( '.' ) ).toLowerCase();
	return MIME_TYPES[ ext ] || 'application/octet-stream';

}

const server = Bun.serve( {
	port: PORT,
	async fetch( req ) {

		const url = new URL( req.url );
		let path = url.pathname;

		// Default to index.html
		if ( path === '/' ) {

			path = '/index.html';

		}

		// Resolve file path
		const filePath = '.' + path;

		try {

			const file = Bun.file( filePath );
			const exists = await file.exists();

			if ( ! exists ) {

				return new Response( 'Not Found', { status: 404 } );

			}

			return new Response( file, {
				headers: {
					'Content-Type': getMimeType( path ),
					'Cache-Control': 'no-cache',
				},
			} );

		} catch ( err ) {

			console.error( 'Error serving', path, err );
			return new Response( 'Internal Server Error', { status: 500 } );

		}

	},
} );

console.log( `\n  Three-Quake server running at http://localhost:${server.port}\n` );
console.log( '  Place pak0.pak in the project root directory to play.' );
console.log( '  Press Ctrl+C to stop.\n' );
