// Variáveis mínimas para o `env()` validar. Valores fictícios — os testes desta
// suíte não tocam banco, Redis nem a API da Anthropic.
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.AUTH_SECRET ??= "test-secret-nao-usar-em-producao";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
