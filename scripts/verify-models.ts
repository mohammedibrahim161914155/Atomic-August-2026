import fs from 'fs';
import path from 'path';

async function verifyModels() {
  console.log('Fetching models from OpenRouter...');
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models');
    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.statusText}`);
    }
    const data = await response.json();
    const openRouterModels = new Set(data.data.map((m: any) => m.id));

    // Read the providers.ts file to extract model IDs
    const providersPath = path.join(process.cwd(), 'src', 'lib', 'providers.ts');
    const providersContent = fs.readFileSync(providersPath, 'utf-8');
    
    // Simple regex to extract model IDs
    const modelIdRegex = /id:\s*'([^']+)'/g;
    let match;
    const hardcodedModels = new Set<string>();
    
    while ((match = modelIdRegex.exec(providersContent)) !== null) {
      if (match[1]) hardcodedModels.add(match[1]);
    }

    console.log(`Found ${hardcodedModels.size} hardcoded models.`);
    console.log(`Found ${openRouterModels.size} OpenRouter models.`);

    let staleCount = 0;
    for (const model of hardcodedModels) {
      // Some models might not be prefixed with provider in our list if they are not openrouter
      // But for openrouter provider, they should match exactly.
      // Let's just check if the model exists in OpenRouter's list.
      // Note: This is a simple check. Some of our models might be for other providers directly.
      // But the PDF says "All models accessible via OpenRouter with a single API key."
      // So they should all exist in OpenRouter.
      if (!openRouterModels.has(model)) {
        console.warn(`⚠️  Stale or missing model slug: ${model}`);
        staleCount++;
      }
    }

    if (staleCount === 0) {
      console.log('✅ All hardcoded models are valid and up-to-date.');
    } else {
      console.log(`❌ Found ${staleCount} stale model slugs.`);
    }

  } catch (error) {
    console.error('Error verifying models:', error);
  }
}

verifyModels();
