import http from 'http';

http.get('http://localhost:5000/api/v1/boards/small', {
  headers: {
    // Just a dummy authorization to bypass middleware if needed, though it might fail if invalid.
    // Wait, the API requires a valid Bearer token.
    // Let's just hit the health endpoint first to see if the server is up.
  }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Body:', data.slice(0, 500));
  });
}).on('error', err => console.log('Error:', err.message));
