try {
  const res = await fetch('http://127.0.0.1:4040/api/tunnels');
  console.log('Ngrok API Response Status:', res.status);
  const data = await res.json();
  console.log('Active Tunnels:', data.tunnels.map(t => ({ name: t.name, public_url: t.public_url, addr: t.config.addr })));
} catch (err) {
  console.error('Error fetching from Ngrok API:', err);
}
