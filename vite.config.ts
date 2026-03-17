import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [
      {
        name: 'token-generator',
        configureServer(server) {
          server.middlewares.use('/api/token', async (req, res) => {
            if (req.method !== 'GET') {
              res.statusCode = 405;
              res.end('Method not allowed');
              return;
            }

            if (!env.OPENAI_API_KEY) {
              res.statusCode = 500;
              res.end('OPENAI_API_KEY not set');
              return;
            }

            try {
              console.log('Fetching token from OpenAI...');
              const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  session: {
                    type: 'realtime',
                    model: 'gpt-realtime',
                    audio: {
                      output: {
                        voice: 'alloy'
                      }
                    }
                  }
                })
              });

              if (!response.ok) {
                const error = await response.text();
                console.error('OpenAI error:', response.status, error);
                res.statusCode = response.status;
                res.end(error);
                return;
              }

              const data = await response.json();
              console.log('OpenAI response received', data);
              res.setHeader('Content-Type', 'application/json');
              const token = data?.value || data.secret || data.id;
              res.end(JSON.stringify({ value: token }));
            } catch (error: any) {
              console.error('Local error:', error);
              res.statusCode = 500;
              res.end('Internal Server Error: ' + error.message);
            }
          });
        }
      }
    ]
  };
});
