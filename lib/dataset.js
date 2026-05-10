const fs = require('fs');
const path = require('path');

class DatasetManager {
  constructor() {
    this.dataDir = path.join(__dirname, '..', 'data');
    this.ensureDataDir();
    this.datasets = new Map();
    this.loadAllDatasets();
  }

  ensureDataDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
      console.log(`📁 Created data directory: ${this.dataDir}`);
    }
  }

  loadAllDatasets() {
    try {
      const files = fs.readdirSync(this.dataDir);
      
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(this.dataDir, file);
          const datasetName = file.replace('.json', '');
          
          try {
            const content = fs.readFileSync(filePath, 'utf8');
            const data = JSON.parse(content);
            this.datasets.set(datasetName, {
              name: datasetName,
              file: filePath,
              data: data,
              loadedAt: new Date().toISOString()
            });
            console.log(`✅ Loaded dataset: ${datasetName}`);
          } catch (error) {
            console.error(`❌ Error loading dataset ${file}:`, error.message);
          }
        }
      }
      
      if (this.datasets.size === 0) {
        console.log('⚠️ No datasets found in data directory');
      }
    } catch (error) {
      console.error('Error loading datasets:', error.message);
    }
  }

  getAllDocuments() {
    const allDocs = [];
    
    for (const [name, dataset] of this.datasets) {
      if (dataset.data.documents && Array.isArray(dataset.data.documents)) {
        for (const doc of dataset.data.documents) {
          allDocs.push({
            source: `${name}/${doc.source || 'unknown'}`,
            text: doc.text || ''
          });
        }
      }
      
      if (dataset.data.faq && Array.isArray(dataset.data.faq)) {
        for (const faq of dataset.data.faq) {
          allDocs.push({
            source: `${name}/FAQ: ${faq.question || 'unknown'}`,
            text: `${faq.question}\n${faq.answer}`
          });
        }
      }
    }
    
    return allDocs;
  }

  getDatasetDocuments(datasetName) {
    const dataset = this.datasets.get(datasetName);
    if (!dataset) return [];
    
    const docs = [];
    
    if (dataset.data.documents && Array.isArray(dataset.data.documents)) {
      for (const doc of dataset.data.documents) {
        docs.push({
          source: `${datasetName}/${doc.source || 'unknown'}`,
          text: doc.text || ''
        });
      }
    }
    
    if (dataset.data.faq && Array.isArray(dataset.data.faq)) {
      for (const faq of dataset.data.faq) {
        docs.push({
          source: `${datasetName}/FAQ: ${faq.question || 'unknown'}`,
          text: `${faq.question}\n${faq.answer}`
        });
      }
    }
    
    return docs;
  }

  saveDataset(datasetName, data) {
    try {
      const filePath = path.join(this.dataDir, `${datasetName}.json`);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      
      this.datasets.set(datasetName, {
        name: datasetName,
        file: filePath,
        data: data,
        loadedAt: new Date().toISOString()
      });
      
      console.log(`✅ Saved dataset: ${datasetName}`);
      return { success: true, message: `Dataset ${datasetName} saved` };
    } catch (error) {
      console.error(`Error saving dataset ${datasetName}:`, error.message);
      return { success: false, message: error.message };
    }
  }

  listDatasets() {
    return Array.from(this.datasets.values()).map(d => ({
      name: d.name,
      loadedAt: d.loadedAt,
      documentCount: this.getDatasetDocuments(d.name).length
    }));
  }

  reloadDatasets() {
    this.datasets.clear();
    this.loadAllDatasets();
  }
}

module.exports = DatasetManager;
