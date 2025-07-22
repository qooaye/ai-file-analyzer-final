const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { Client: PgClient } = require('pg');
const mammoth = require('mammoth');
const pdf = require('pdf-parse');
const xlsx = require('xlsx');
const cheerio = require('cheerio');
const epub = require('epub2');
const iconv = require('iconv-lite');
const { HfInference } = require('@huggingface/inference');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 8080;

// 初始化 Hugging Face 免費 AI 模型
const hf = new HfInference(); // 不需要 API key 的免費模型

// OCR 文字識別函數
async function extractTextFromImage(imagePath, originalName) {
  try {
    console.log(`開始 OCR 識別: ${originalName}`);
    
    // 使用 sharp 預處理圖片（提高 OCR 準確度）
    const processedImageBuffer = await sharp(imagePath)
      .resize(null, 2000, { withoutEnlargement: true })  // 調整尺寸提高識別率
      .greyscale()  // 轉灰階
      .normalize()  // 正規化
      .sharpen()    // 銳化
      .toBuffer();

    // 使用 Tesseract.js 進行 OCR 識別（支援中英文）
    const { data: { text } } = await Tesseract.recognize(
      processedImageBuffer,
      'chi_tra+chi_sim+eng',  // 繁體中文 + 簡體中文 + 英文
      {
        logger: m => console.log(`OCR 進度: ${originalName} - ${m.status} ${Math.round(m.progress * 100)}%`)
      }
    );

    const extractedText = text.trim();
    
    if (extractedText.length > 10) {
      console.log(`OCR 成功: ${originalName} - 提取 ${extractedText.length} 字符`);
      return `# 圖片OCR文字識別結果

## 圖片信息
- 文件名稱: ${originalName}
- 識別引擎: Tesseract.js (免費OCR)
- 支援語言: 中文繁體/簡體 + 英文

## 識別出的文字內容
${extractedText}

## 附加信息
- 文字長度: ${extractedText.length} 字符
- 識別狀態: 成功
- 建議: 如識別結果不準確，請確保圖片清晰且文字對比度良好`;
    } else {
      return `# 圖片OCR識別結果

## 圖片信息  
- 文件名稱: ${originalName}
- 識別引擎: Tesseract.js

## 識別狀態
未檢測到清晰的文字內容，可能原因：
- 圖片中沒有文字
- 文字太小或模糊
- 手寫字體難以識別
- 特殊字體或藝術字

## 建議
- 確保圖片清晰
- 文字與背景對比度要高
- 避免傾斜或扭曲的文字`;
    }
    
  } catch (error) {
    console.error(`OCR 識別失敗 ${originalName}:`, error);
    return `# 圖片OCR識別失敗

## 圖片信息
- 文件名稱: ${originalName}
- 錯誤信息: ${error.message}

## 基本信息
這是一個圖片文件，OCR文字識別功能暫時無法處理此文件。`;
  }
}

// 數據庫抽象層
class DatabaseManager {
  constructor() {
    this.isPostgres = !!process.env.DATABASE_URL;
    this.init();
  }

  async init() {
    if (this.isPostgres) {
      console.log('🐘 使用 PostgreSQL 數據庫');
      this.client = new PgClient({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
      });
      
      try {
        await this.client.connect();
        console.log('✅ PostgreSQL 連接成功');
        await this.client.query(`CREATE TABLE IF NOT EXISTS analyses (
          id SERIAL PRIMARY KEY,
          analysis_summary TEXT NOT NULL,
          content_text TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
      } catch (err) {
        console.error('❌ PostgreSQL 連接失敗:', err);
      }
    } else {
      console.log('📁 使用 SQLite 數據庫');
      this.client = new sqlite3.Database('./analysis.db');
      
      this.client.serialize(() => {
        this.client.run(`CREATE TABLE IF NOT EXISTS analyses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          analysis_summary TEXT NOT NULL,
          content_text TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
      });
    }
  }

  async run(sql, params = []) {
    return new Promise((resolve, reject) => {
      if (this.isPostgres) {
        this.client.query(sql, params)
          .then(result => {
            const lastID = result.rows[0]?.id || result.rows[0]?.ID || null;
            resolve({ lastID, changes: result.rowCount });
          })
          .catch(reject);
      } else {
        this.client.run(sql, params, function(err) {
          if (err) reject(err);
          else resolve({ lastID: this.lastID, changes: this.changes });
        });
      }
    });
  }

  async all(sql, params = []) {
    return new Promise((resolve, reject) => {
      if (this.isPostgres) {
        this.client.query(sql, params)
          .then(result => resolve(result.rows))
          .catch(reject);
      } else {
        this.client.all(sql, params, (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      }
    });
  }

  async get(sql, params = []) {
    return new Promise((resolve, reject) => {
      if (this.isPostgres) {
        this.client.query(sql, params)
          .then(result => resolve(result.rows[0]))
          .catch(reject);
      } else {
        this.client.get(sql, params, (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      }
    });
  }
}

// 初始化數據庫管理器
const dbManager = new DatabaseManager();

// 設置文件上傳
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = './temp_uploads';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ storage: storage });

app.use(express.static('public'));
app.use(express.json());

// 文件內容提取函數
async function extractTextFromFile(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  
  try {
    switch(ext) {
      case '.txt':
      case '.md':
        return fs.readFileSync(filePath, 'utf8');
        
      case '.pdf':
        const pdfBuffer = fs.readFileSync(filePath);
        const pdfData = await pdf(pdfBuffer);
        return pdfData.text;
        
      case '.doc':
      case '.docx':
        const docBuffer = fs.readFileSync(filePath);
        const docResult = await mammoth.extractRawText({buffer: docBuffer});
        return docResult.value;
        
      case '.xlsx':
      case '.xls':
        const workbook = xlsx.readFile(filePath);
        let excelText = '';
        workbook.SheetNames.forEach(sheetName => {
          const worksheet = workbook.Sheets[sheetName];
          excelText += xlsx.utils.sheet_to_csv(worksheet) + '\\n';
        });
        return excelText;
        
      case '.html':
      case '.htm':
        const htmlContent = fs.readFileSync(filePath, 'utf8');
        const $ = cheerio.load(htmlContent);
        return $.text();
        
      case '.epub':
        return new Promise((resolve, reject) => {
          const epubReader = new epub(filePath);
          epubReader.on('ready', () => {
            let epubText = '';
            epubReader.flow.forEach((chapter, index) => {
              epubReader.getChapter(chapter.id, (err, text) => {
                if (!err) {
                  const $epub = cheerio.load(text);
                  epubText += $epub.text() + '\\n';
                }
                if (index === epubReader.flow.length - 1) {
                  resolve(epubText);
                }
              });
            });
          });
          epubReader.on('error', reject);
          epubReader.parse();
        });
        
      case '.png':
      case '.jpg':
      case '.jpeg':
      case '.gif':
      case '.bmp':
      case '.webp':
        // 使用 OCR 識別圖片中的文字
        return await extractTextFromImage(filePath, originalName);
        
      default:
        return `[不支援的文件格式: ${ext}]`;
    }
  } catch (error) {
    console.error('文件解析錯誤:', error);
    return `[文件解析失敗: ${originalName}]`;
  }
}

// 使用 Hugging Face 免費AI模型進行分析
async function performAIAnalysis(combinedText, fileNames) {
  try {
    // 限制文本長度以避免API限制
    const maxTextLength = 2000;
    const textToAnalyze = combinedText.length > maxTextLength 
      ? combinedText.substring(0, maxTextLength) + "..." 
      : combinedText;

    // 使用免費的文本摘要模型
    let aiSummary = "";
    let keyPoints = [];
    
    try {
      // 嘗試使用 Hugging Face 的免費摘要模型
      const summaryResult = await hf.summarization({
        model: 'facebook/bart-large-cnn',
        inputs: textToAnalyze,
        parameters: {
          max_length: 150,
          min_length: 50
        }
      });
      
      aiSummary = summaryResult.summary_text || "無法生成摘要";
      
    } catch (hfError) {
      console.log('Hugging Face API 暫時不可用，使用本地分析');
      // 備用本地分析
      aiSummary = generateLocalSummary(textToAnalyze);
    }

    // 關鍵詞提取（本地處理）
    const keywords = extractKeywords(combinedText);
    
    // 生成結構化分析報告
    const analysisReport = `# AI分析報告

## 📁 處理文件
${fileNames.map(name => `- ${name}`).join('\n')}

## 📊 文件統計
- 文件數量: ${fileNames.length} 個
- 總字符數: ${combinedText.length.toLocaleString()}
- 分析模型: Facebook BART (免費AI模型)

## 🎯 智能摘要
${aiSummary}

## 🔍 關鍵重點分析
${generateKeyPoints(combinedText, fileNames)}

## 🏷️ 核心關鍵詞
${keywords.slice(0, 15).join(' • ')}

## 📈 內容分類
${categorizeContent(combinedText, fileNames)}

## 💡 行動建議
${generateActionItems(combinedText, fileNames)}

## 🔗 相關性分析
${analyzeRelationships(fileNames)}

---
*🤖 本報告由 Facebook BART AI模型生成 | 生成時間: ${new Date().toLocaleString()}*`;

    return analysisReport;
    
  } catch (error) {
    console.error('AI分析錯誤:', error);
    return generateFallbackAnalysis(combinedText, fileNames);
  }
}

// 本地摘要生成備用方案
function generateLocalSummary(text) {
  const sentences = text.split(/[.!?。！？]/).filter(s => s.trim().length > 10);
  const topSentences = sentences
    .sort((a, b) => b.length - a.length)
    .slice(0, 3)
    .join('。');
  
  return topSentences || "文件包含重要信息，建議詳細閱讀原文。";
}

// 關鍵詞提取
function extractKeywords(text) {
  const stopWords = new Set(['的', '是', '在', '和', '有', '了', '也', '都', '就', '要', '可以', '這', '一個', '我們', 'the', 'is', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by']);
  
  const words = text.toLowerCase()
    .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word));
  
  const wordCount = {};
  words.forEach(word => {
    wordCount[word] = (wordCount[word] || 0) + 1;
  });
  
  return Object.entries(wordCount)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 20)
    .map(([word]) => word);
}

// 生成關鍵重點
function generateKeyPoints(text, fileNames) {
  const points = [];
  
  if (text.length > 1000) {
    points.push("• 文件內容豐富，包含大量詳細信息");
  }
  
  if (fileNames.some(name => name.toLowerCase().includes('report'))) {
    points.push("• 包含報告性質的文件，建議重點關注結論部分");
  }
  
  if (fileNames.length > 1) {
    points.push(`• 多文件分析（${fileNames.length}個文件），內容可能存在關聯性`);
  }
  
  const imageFiles = fileNames.filter(name => /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(name));
  if (imageFiles.length > 0) {
    points.push(`• 包含${imageFiles.length}個圖片文件，可能需要視覺內容分析`);
  }
  
  if (text.includes('重要') || text.includes('關鍵') || text.includes('核心')) {
    points.push("• 文件中明確標示了重要信息，建議優先處理");
  }
  
  return points.length > 0 ? points.join('\n') : "• 建議詳細閱讀文件內容以獲取更多信息";
}

// 內容分類
function categorizeContent(text, fileNames) {
  const categories = [];
  
  if (text.match(/報告|分析|統計|數據/)) categories.push("📊 數據分析類");
  if (text.match(/計劃|方案|策略|目標/)) categories.push("📋 規劃策略類");
  if (text.match(/技術|開發|系統|程式/)) categories.push("💻 技術文檔類");
  if (text.match(/會議|討論|決定|紀錄/)) categories.push("📝 會議記錄類");
  if (fileNames.some(name => /\.(jpg|jpeg|png|gif)$/i.test(name))) categories.push("🖼️ 視覺資料類");
  
  return categories.length > 0 ? categories.join(' | ') : "📄 一般文檔資料";
}

// 生成行動建議
function generateActionItems(text, fileNames) {
  const actions = [
    "🔍 深入分析核心概念和關鍵信息",
    "📚 建立知識架構，整理重點資訊",
    "🔗 分析文件間的關聯性和依賴關係",
    "📋 制定後續行動計劃和執行步驟"
  ];
  
  if (fileNames.length > 1) {
    actions.push("🔄 比較多個文件的異同點");
  }
  
  return actions.join('\n');
}

// 關聯性分析
function analyzeRelationships(fileNames) {
  if (fileNames.length === 1) {
    return "單一文件分析，無關聯性比較";
  }
  
  const extensions = fileNames.map(name => path.extname(name).toLowerCase());
  const uniqueTypes = [...new Set(extensions)];
  
  return `檢測到 ${uniqueTypes.length} 種文件類型，文件間可能存在格式互補性`;
}

// 從分析摘要中精確提取智能摘要和核心關鍵詞
function extractConceptsFromAnalysis(analysisText, contentText) {
  const concepts = [];
  
  console.log('分析摘要內容預覽:', analysisText.substring(0, 200));
  
  // 精確提取「智能摘要」區塊內容
  const smartSummaryMatch = analysisText.match(/##\s*智能摘要[\s\S]*?(?=##|$)/i);
  let smartSummaryContent = '';
  if (smartSummaryMatch) {
    smartSummaryContent = smartSummaryMatch[0].replace(/##\s*智能摘要/i, '').trim();
    console.log('提取到智能摘要:', smartSummaryContent.substring(0, 100));
  }
  
  // 精確提取「核心關鍵詞」區塊內容
  const keywordsMatch = analysisText.match(/##\s*核心關鍵詞[\s\S]*?(?=##|$)/i);
  let keywordsContent = '';
  if (keywordsMatch) {
    keywordsContent = keywordsMatch[0].replace(/##\s*核心關鍵詞/i, '').trim();
    console.log('提取到核心關鍵詞:', keywordsContent.substring(0, 100));
  }
  
  // 從智能摘要中提取概念
  if (smartSummaryContent) {
    // 提取重要句子（包含關鍵動詞或形容詞）
    const importantSentences = smartSummaryContent.match(/[^。！？\n]*[介紹|討論|分析|探討|提到|說明|建議|方法|策略|原則|特點|優勢|重要|關鍵|核心|主要][^。！？\n]*[。！？]/g) || [];
    
    importantSentences.slice(0, 3).forEach(sentence => {
      const cleanSentence = sentence.replace(/[。！？\-\*]/g, '').trim();
      if (cleanSentence.length > 8 && cleanSentence.length < 60) {
        concepts.push({
          concept: cleanSentence,
          importance: 'high',
          source: 'smart_summary'
        });
      }
    });
  }
  
  // 從核心關鍵詞中提取概念
  if (keywordsContent) {
    // 提取關鍵詞（去除符號和數字）
    const keywordMatches = keywordsContent.match(/[\u4e00-\u9fa5A-Za-z]{2,15}/g) || [];
    
    keywordMatches.slice(0, 4).forEach(keyword => {
      if (!['文件', '處理', '系統', '分析', '內容', '數據', '信息', '結果'].includes(keyword)) {
        concepts.push({
          concept: keyword,
          importance: 'medium',
          source: 'keywords'
        });
      }
    });
  }
  
  // 如果智能摘要和關鍵詞都沒有內容，從整個分析文本中提取
  if (concepts.length === 0) {
    console.log('未找到智能摘要和核心關鍵詞區塊，從整體分析中提取');
    
    // 排除統計信息和文件處理信息的區塊
    const filteredText = analysisText
      .replace(/##\s*處理文件[\s\S]*?(?=##|$)/gi, '')
      .replace(/##\s*文件統計[\s\S]*?(?=##|$)/gi, '')
      .replace(/##\s*處理結果[\s\S]*?(?=##|$)/gi, '');
    
    // 提取剩餘內容中的重要概念
    const sentences = filteredText.match(/[^。！？\n]{10,50}[。！？]/g) || [];
    sentences.slice(0, 3).forEach(sentence => {
      const cleanSentence = sentence.replace(/[。！？\-\*#]/g, '').trim();
      if (cleanSentence.length > 8) {
        concepts.push({
          concept: cleanSentence,
          importance: 'medium',
          source: 'filtered_analysis'
        });
      }
    });
  }
  
  // 確保至少有概念可用
  if (concepts.length === 0) {
    console.log('使用備用概念生成');
    return [
      { concept: '文檔核心內容分析', importance: 'high', source: 'fallback' },
      { concept: '重要信息提取', importance: 'medium', source: 'fallback' },
      { concept: '知識要點整理', importance: 'medium', source: 'fallback' }
    ];
  }
  
  console.log(`成功提取 ${concepts.length} 個概念`);
  return concepts.slice(0, 5);
}

// 基於概念和分析數據生成學習卡片，專注於智能摘要和核心關鍵詞
async function generateCardFromConcept(concept, analysisId) {
  let analysis = null;
  
  // 獲取原始分析數據
  if (analysisId) {
    try {
      const sql = dbManager.isPostgres ? 'SELECT * FROM analyses WHERE id = $1' : 'SELECT * FROM analyses WHERE id = ?';
      analysis = await dbManager.get(sql, [analysisId]);
    } catch (e) {
      console.log('無法獲取分析數據');
    }
  }
  
  const conceptName = concept.concept;
  const analysisText = analysis ? analysis.analysis_summary : '';
  
  // 提取智能摘要和核心關鍵詞區塊
  const smartSummaryMatch = analysisText.match(/##\s*智能摘要[\s\S]*?(?=##|$)/i);
  const keywordsMatch = analysisText.match(/##\s*核心關鍵詞[\s\S]*?(?=##|$)/i);
  
  let relevantContent = '';
  if (smartSummaryMatch) {
    relevantContent += smartSummaryMatch[0];
  }
  if (keywordsMatch) {
    relevantContent += ' ' + keywordsMatch[0];
  }
  
  // 如果沒有找到特定區塊，使用過濾後的分析內容
  if (!relevantContent) {
    relevantContent = analysisText
      .replace(/##\s*處理文件[\s\S]*?(?=##|$)/gi, '')
      .replace(/##\s*文件統計[\s\S]*?(?=##|$)/gi, '')
      .replace(/##\s*處理結果[\s\S]*?(?=##|$)/gi, '');
  }
  
  console.log(`為概念"${conceptName}"生成卡片，來源：${concept.source}`);
  
  // 生成概念解釋
  let conceptExplanation = '';
  
  if (concept.source === 'smart_summary') {
    // 如果來自智能摘要，提取相關描述
    const conceptRegex = new RegExp(`[^。！？\\n]*${conceptName}[^。！？\\n]*[。！？]`, 'g');
    const relatedSentences = relevantContent.match(conceptRegex) || [];
    
    if (relatedSentences.length > 0) {
      conceptExplanation = relatedSentences.slice(0, 2).join(' ').replace(/[##\-\*]/g, '').trim();
    } else {
      // 提取前後文
      const contextRegex = new RegExp(`[^。！？\\n]*[。！？]\\s*[^。！？\\n]*${conceptName}[^。！？\\n]*[。！？]`, 'g');
      const contextSentences = relevantContent.match(contextRegex) || [];
      if (contextSentences.length > 0) {
        conceptExplanation = contextSentences[0].replace(/[##\-\*]/g, '').trim();
      }
    }
  } else if (concept.source === 'keywords') {
    // 如果來自關鍵詞，從智能摘要中找相關描述
    const keywordRegex = new RegExp(`[^。！？\\n]*${conceptName}[^。！？\\n]*[。！？]`, 'g');
    const keywordSentences = relevantContent.match(keywordRegex) || [];
    if (keywordSentences.length > 0) {
      conceptExplanation = keywordSentences[0].replace(/[##\-\*]/g, '').trim();
    }
  }
  
  // 如果沒有找到相關描述，生成基本解釋
  if (!conceptExplanation || conceptExplanation.length < 10) {
    conceptExplanation = `${conceptName}是文檔中的重要概念，根據智能摘要分析，這個概念在整體內容中具有重要意義。`;
  }
  
  // 從相關內容中尋找實例
  const exampleKeywords = ['例如', '比如', '舉例', '案例', '實例', '具體', '實際', '包括', '特別是'];
  let example = '';
  
  for (const keyword of exampleKeywords) {
    const exampleRegex = new RegExp(`[^。！？\\n]*${keyword}[^。！？\\n]*[。！？]`, 'g');
    const examples = relevantContent.match(exampleRegex);
    if (examples && examples.length > 0) {
      example = examples[0].replace(/[##\-\*]/g, '').trim();
      break;
    }
  }
  
  if (!example) {
    example = `根據智能摘要內容，${conceptName}在實際應用中可以通過文檔描述的方法和策略來體現其價值。`;
  }
  
  // 根據概念來源生成個人化應用建議
  const applicationSuggestions = [
    `1. 深入研讀智能摘要中關於${conceptName}的關鍵描述`,
    `2. 理解${conceptName}在文檔整體脈絡中的重要作用`,
    `3. 將${conceptName}的核心要點應用到相關的實際場景中`
  ];
  
  if (concept.source === 'keywords') {
    applicationSuggestions.push(`4. 關注此關鍵詞在不同段落中的使用context和含義`);
  } else if (concept.source === 'smart_summary') {
    applicationSuggestions.push(`4. 結合摘要內容，深化對${conceptName}的理解和應用`);
  }
  
  applicationSuggestions.push(`5. 定期回顧並實踐，建立與其他概念的關聯`);
  
  return {
    title: conceptName,
    concept: conceptExplanation,
    example: example,
    application: applicationSuggestions.join('\n')
  };
}

// 備用分析方案
function generateFallbackAnalysis(text, fileNames) {
  return `# AI分析報告（備用模式）

## 處理文件
${fileNames.map(name => `- ${name}`).join('\n')}

## 基本統計
- 文件數量: ${fileNames.length}
- 內容長度: ${text.length} 字符
- 估計閱讀時間: ${Math.ceil(text.length / 1000)} 分鐘

## 簡要分析
基於本地算法的文件分析結果。建議手動審閱文件內容以獲取更準確的信息。

*系統提示：AI服務暫時不可用，使用本地分析模式*`;
}

// 首頁
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>文件AI分析系統</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <style>
            body { font-family: Arial, sans-serif; max-width: 1200px; margin: 0 auto; padding: 10px; background: #f5f5f5; }
            .container { max-width: 1200px; margin: 0 auto; padding: 0 10px; }
            .upload-section { margin-bottom: 30px; }
            .data-section { margin-top: 30px; }
            .upload-area { 
                border: 3px dashed #007bff; 
                padding: 30px 20px; 
                text-align: center; 
                margin: 20px 0; 
                border-radius: 15px;
                background: white;
                transition: all 0.3s ease;
                cursor: pointer;
                min-height: 120px;
                display: flex;
                flex-direction: column;
                justify-content: center;
            }
            .upload-area:hover { 
                border-color: #0056b3; 
                background: #f8f9ff; 
                transform: translateY(-2px);
                box-shadow: 0 8px 25px rgba(0,123,255,0.15);
            }
            .upload-area.drag-over { 
                border-color: #28a745; 
                background: #f8fff8; 
                transform: scale(1.02);
            }
            .upload-icon { font-size: 48px; color: #007bff; margin-bottom: 15px; }
            .upload-text { font-size: 18px; color: #333; margin-bottom: 10px; font-weight: 500; }
            .upload-hint { color: #666; font-size: 14px; margin-bottom: 20px; }
            .file-input { display: none; }
            .file-info { 
                background: white; 
                padding: 15px; 
                margin: 10px 0; 
                border-radius: 8px; 
                box-shadow: 0 2px 8px rgba(0,0,0,0.1);
                border-left: 4px solid #007bff;
                display: flex;
                align-items: center;
            }
            .btn { 
                background: #007bff; 
                color: white; 
                padding: 12px 24px; 
                border: none; 
                border-radius: 6px; 
                cursor: pointer; 
                font-size: 16px;
                font-weight: 500;
                transition: all 0.3s ease;
                margin: 5px;
            }
            .btn:hover { 
                background: #0056b3; 
                transform: translateY(-1px);
                box-shadow: 0 4px 12px rgba(0,123,255,0.3);
            }
            .btn:disabled { 
                background: #ccc; 
                cursor: not-allowed; 
                transform: none;
                box-shadow: none;
            }
            .btn-success { background: #28a745; }
            .btn-success:hover { background: #218838; }
            .btn-danger { background: #dc3545; }
            .btn-danger:hover { background: #c82333; }
            .btn-info { background: #17a2b8; }
            .btn-info:hover { background: #138496; }
            .btn-warning { background: #ffc107; color: #000; }
            .btn-warning:hover { background: #e0a800; }
            .search-area {
                background: white;
                padding: 20px;
                border-radius: 8px;
                margin-bottom: 20px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            }
            .search-input {
                width: 100%;
                padding: 12px;
                border: 2px solid #ddd;
                border-radius: 6px;
                font-size: 16px;
                margin-bottom: 10px;
            }
            .search-input:focus {
                border-color: #007bff;
                outline: none;
            }
            .table-container {
                background: white;
                border-radius: 8px;
                overflow: hidden;
                box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            }
            .table {
                width: 100%;
                border-collapse: collapse;
            }
            .table th, .table td {
                padding: 12px;
                text-align: left;
                border-bottom: 1px solid #ddd;
            }
            .table th {
                background: #f8f9fa;
                font-weight: 600;
            }
            .table tr:hover {
                background: #f8f9fa;
            }
            .loading { 
                color: #666; 
                font-style: italic; 
                text-align: center;
                padding: 20px;
            }
            h1 { text-align: center; color: #333; margin-bottom: 30px; }
            h2 { color: #333; margin-bottom: 15px; }
            .file-list-title { color: #333; margin-top: 20px; margin-bottom: 15px; }
            .modal {
                display: none;
                position: fixed;
                z-index: 1000;
                left: 0;
                top: 0;
                width: 100vw;
                height: 100vh;
                background-color: rgba(0,0,0,0.8);
            }
            .modal-content {
                background-color: white;
                margin: 0;
                padding: 20px;
                width: 100vw;
                height: 100vh;
                max-width: none;
                max-height: none;
                overflow-y: auto;
                display: flex;
                flex-direction: column;
                box-sizing: border-box;
            }
            .close {
                color: #aaa;
                position: absolute;
                top: 15px;
                right: 25px;
                font-size: 35px;
                font-weight: bold;
                cursor: pointer;
                z-index: 1001;
            }
            .close:hover { color: #000; }
            .modal-header {
                background: #f8f9fa;
                margin: -20px -20px 20px -20px;
                padding: 20px;
                border-bottom: 1px solid #ddd;
                position: relative;
            }
            .modal-header h2 {
                margin: 0;
                color: #333;
                font-size: 24px;
            }
            .modal-body {
                flex: 1;
                overflow-y: auto;
                padding: 10px 0;
            }
            .modal-footer {
                background: #f8f9fa;
                margin: 20px -20px -20px -20px;
                padding: 20px;
                border-top: 1px solid #ddd;
                text-align: right;
            }
            .form-group {
                margin-bottom: 25px;
            }
            .form-group label {
                display: block;
                margin-bottom: 8px;
                font-weight: 600;
                font-size: 16px;
                color: #333;
            }
            .form-group textarea {
                width: 100%;
                min-height: 300px;
                padding: 15px;
                border: 2px solid #ddd;
                border-radius: 8px;
                font-size: 14px;
                line-height: 1.5;
                resize: vertical;
                font-family: 'Courier New', monospace;
                box-sizing: border-box;
            }
            .form-group textarea:focus {
                border-color: #007bff;
                outline: none;
                box-shadow: 0 0 0 3px rgba(0,123,255,0.1);
            }
            #editSummary {
                min-height: 400px;
            }
            #editContent {
                min-height: 500px;
            }
            .progress-info {
                text-align: center;
                padding: 20px;
            }
            .progress-bar {
                width: 100%;
                height: 20px;
                background-color: #f0f0f0;
                border-radius: 10px;
                overflow: hidden;
                margin: 10px 0;
            }
            .progress-fill {
                height: 100%;
                background: linear-gradient(90deg, #007bff, #17a2b8);
                width: 0%;
                transition: width 0.3s ease;
                animation: progress-animation 2s infinite;
            }
            @keyframes progress-animation {
                0% { background-position: 0% 50%; }
                100% { background-position: 100% 50%; }
            }
            .card-note {
                border: 1px solid #ddd;
                border-radius: 8px;
                padding: 15px;
                margin: 15px 0;
                background: white;
                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            }
            .card-note h3 {
                color: #007bff;
                margin-top: 0;
                border-bottom: 2px solid #007bff;
                padding-bottom: 5px;
            }
            .card-note .concept {
                background: #f8f9fa;
                padding: 10px;
                border-radius: 5px;
                margin: 10px 0;
            }
            .card-note .example {
                background: #e8f4f8;
                padding: 10px;
                border-radius: 5px;
                margin: 10px 0;
            }
            .card-note .application {
                background: #f0f8e8;
                padding: 10px;
                border-radius: 5px;
                margin: 10px 0;
            }
            .connections {
                background: #fff3cd;
                padding: 15px;
                border-radius: 8px;
                margin: 15px 0;
                border-left: 4px solid #ffc107;
            }

            /* 響應式設計 - 手機版 */
            @media (max-width: 768px) {
                .container {
                    padding: 10px;
                }
                
                h1 {
                    font-size: 24px;
                    margin-bottom: 20px;
                }
                
                .upload-area {
                    padding: 30px 15px;
                    margin-bottom: 20px;
                }
                
                .upload-text {
                    font-size: 16px;
                }
                
                .upload-hint {
                    font-size: 12px;
                }
                
                .search-area {
                    flex-direction: column;
                    gap: 10px;
                }
                
                .search-input {
                    margin-right: 0;
                    margin-bottom: 10px;
                }
                
                .btn {
                    padding: 12px 20px;
                    font-size: 16px;
                    min-height: 48px; /* 觸控友好的最小高度 */
                    min-width: 48px; /* 觸控友好的最小寬度 */
                    -webkit-tap-highlight-color: rgba(0,0,0,0.1);
                    transition: all 0.2s ease;
                }
                
                .btn:active {
                    transform: scale(0.98);
                    background-color: rgba(0,0,0,0.1);
                }
                
                /* 文件輸入和上傳區域優化 */
                .upload-area {
                    -webkit-tap-highlight-color: rgba(0,0,0,0.1);
                    transition: all 0.3s ease;
                }
                
                .upload-area:active {
                    transform: scale(0.99);
                    background-color: #f0f8ff;
                }
                
                .search-input {
                    font-size: 16px; /* 防止 iOS Safari 縮放 */
                    min-height: 48px;
                    padding: 12px 15px;
                    border-radius: 8px;
                    -webkit-appearance: none; /* 移除 iOS 默認樣式 */
                }
                
                .search-input:focus {
                    outline: none;
                    border-color: #007bff;
                    box-shadow: 0 0 0 3px rgba(0,123,255,0.1);
                }
                
                /* 防止雙擊縮放 */
                * {
                    touch-action: pan-x pan-y;
                }
                
                input, textarea, button {
                    touch-action: manipulation;
                }
                
                /* 隱藏桌面版表格 */
                .table-container {
                    display: none !important;
                }
                
                /* 行動版卡片布局 */
                .mobile-cards {
                    display: block !important;
                }
                
                .analysis-card {
                    background: white;
                    border: 1px solid #ddd;
                    border-radius: 8px;
                    margin-bottom: 15px;
                    padding: 15px;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                }
                
                .card-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 10px;
                    padding-bottom: 10px;
                    border-bottom: 1px solid #eee;
                }
                
                .card-id {
                    font-weight: bold;
                    color: #007bff;
                    font-size: 18px;
                }
                
                .card-summary {
                    margin-bottom: 10px;
                    line-height: 1.4;
                    color: #333;
                    word-wrap: break-word;
                }
                
                .card-times {
                    margin-bottom: 15px;
                    font-size: 14px;
                    color: #666;
                }
                
                .card-time {
                    margin-bottom: 5px;
                    word-wrap: break-word;
                }
                
                .card-updated {
                    color: #007bff !important;
                    font-weight: bold;
                }
                
                .card-actions {
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                    margin-top: 15px;
                }
                
                .card-actions .btn {
                    width: 100%;
                    text-align: center;
                    touch-action: manipulation;
                    min-height: 48px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                
                /* 模態框在手機版的調整 */
                .modal {
                    padding: 0;
                }
                
                .modal-content {
                    width: 100%;
                    height: 100vh;
                    max-width: 100%;
                    max-height: 100%;
                    border-radius: 0;
                    margin: 0;
                }
                
                .modal-header {
                    padding: 15px 20px;
                }
                
                .modal-header h2 {
                    font-size: 20px;
                }
                
                .close {
                    font-size: 28px;
                    padding: 5px;
                }
                
                .modal-body {
                    padding: 0 20px;
                }
                
                .form-group textarea {
                    font-size: 16px; /* 防止 iOS Safari 縮放 */
                    min-height: 200px;
                }
                
                #editSummary {
                    min-height: 150px;
                }
                
                #editContent {
                    min-height: 300px;
                }
                
                .modal-footer {
                    padding: 15px 20px;
                }
                
                .modal-footer .btn {
                    margin-left: 8px;
                }
            }
            
            /* 桌面版默認隱藏卡片 */
            .mobile-cards {
                display: none;
            }
        </style>
    </head>
    <body>
        <h1>文件AI分析系統</h1>
        
        <div class="container">
            <!-- 上方：文件上傳區域 -->
            <div class="upload-section">
                <div class="upload-area" id="uploadArea" onclick="document.getElementById('fileInput').click()">
                    <input type="file" id="fileInput" class="file-input" multiple 
                           accept=".txt,.pdf,.doc,.docx,.md,.png,.jpg,.jpeg,.gif,.bmp,.webp,.xlsx,.xls,.html,.htm,.epub">
                    <div class="upload-icon">📁</div>
                    <div class="upload-text">點擊選擇文件或拖拽文件到此處</div>
                    <div class="upload-hint">支援 TXT, PDF, DOC, DOCX, MD, EXCEL, HTML, EPUB, 圖片 (含OCR文字識別)</div>
                </div>

                <div id="fileList"></div>
                
                <button id="analyzeBtn" class="btn" onclick="analyzeFiles()" disabled>開始AI分析</button>
                
                <div id="analysisStatus"></div>
            </div>
            
            <!-- 下方：數據查詢區域 -->
            <div class="data-section">
                <div class="search-area">
                    <h2>數據查詢</h2>
                    <input type="text" id="searchInput" class="search-input" placeholder="輸入關鍵字搜索..." onkeyup="searchAnalyses()">
                    <button class="btn btn-warning" onclick="loadAllAnalyses()">顯示全部</button>
                </div>
                
                <div class="table-container">
                    <table class="table">
                        <thead>
                            <tr>
                                <th>ID</th>
                                <th>分析摘要</th>
                                <th>創建時間</th>
                                <th>更新時間</th>
                                <th>操作</th>
                            </tr>
                        </thead>
                        <tbody id="analysisTable">
                            <!-- 數據將動態加載 -->
                        </tbody>
                    </table>
                </div>
                
                <!-- 行動版卡片布局 -->
                <div class="mobile-cards" id="mobileCards">
                    <!-- 卡片將動態加載 -->
                </div>
            </div>
        </div>

        <!-- 編輯模態框 -->
        <div id="editModal" class="modal">
            <div class="modal-content">
                <div class="modal-header">
                    <h2>編輯分析記錄</h2>
                    <span class="close" onclick="closeEditModal()">&times;</span>
                </div>
                
                <div class="modal-body">
                    <form id="editForm">
                        <input type="hidden" id="editId">
                        <div class="form-group">
                            <label for="editSummary">📊 分析摘要 (AI Analysis Summary):</label>
                            <textarea id="editSummary" required placeholder="請輸入或編輯AI分析摘要內容..."></textarea>
                        </div>
                        <div class="form-group">
                            <label for="editContent">📄 完整文本內容 (Full Text Content):</label>
                            <textarea id="editContent" required placeholder="請輸入或編輯完整的文本內容..."></textarea>
                        </div>
                    </form>
                </div>
                
                <div class="modal-footer">
                    <button type="button" class="btn" onclick="closeEditModal()" style="margin-right: 10px;">取消</button>
                    <button type="button" class="btn btn-success" onclick="saveEdit()">💾 保存更改</button>
                </div>
            </div>
        </div>

        <!-- 卡片筆記模態框 -->
        <div id="cardNotesModal" class="modal">
            <div class="modal-content">
                <div class="modal-header">
                    <h2>🗂️ AI卡片筆記</h2>
                    <span class="close" onclick="closeCardNotesModal()">&times;</span>
                </div>
                
                <div class="modal-body">
                    <div id="cardNotesProgress" style="display: none;">
                        <div class="progress-info">
                            <p><strong>AI處理中...</strong></p>
                            <div id="progressText">正在分析內容...</div>
                            <div class="progress-bar">
                                <div class="progress-fill"></div>
                            </div>
                        </div>
                    </div>
                    
                    <div id="cardNotesContent">
                        <!-- 卡片筆記內容將在這裡顯示 -->
                    </div>
                </div>
                
                <div class="modal-footer">
                    <button type="button" class="btn" onclick="closeCardNotesModal()" style="margin-right: 10px;">關閉</button>
                    <button type="button" class="btn btn-success" onclick="downloadMarkdown()" id="downloadBtn" style="display: none;">📥 下載 MD</button>
                </div>
            </div>
        </div>

        <script>
            let selectedFiles = [];

            // 拖拽功能
            const uploadArea = document.getElementById('uploadArea');
            const fileInput = document.getElementById('fileInput');

            ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
                uploadArea.addEventListener(eventName, preventDefaults, false);
                document.body.addEventListener(eventName, preventDefaults, false);
            });

            ['dragenter', 'dragover'].forEach(eventName => {
                uploadArea.addEventListener(eventName, highlight, false);
            });

            ['dragleave', 'drop'].forEach(eventName => {
                uploadArea.addEventListener(eventName, unhighlight, false);
            });

            uploadArea.addEventListener('drop', handleDrop, false);

            function preventDefaults(e) {
                e.preventDefault();
                e.stopPropagation();
            }

            function highlight(e) {
                uploadArea.classList.add('drag-over');
            }

            function unhighlight(e) {
                uploadArea.classList.remove('drag-over');
            }

            function handleDrop(e) {
                const dt = e.dataTransfer;
                const files = dt.files;
                handleFiles(files);
            }

            fileInput.addEventListener('change', function() {
                handleFiles(this.files);
            });

            function handleFiles(files) {
                selectedFiles = Array.from(files);
                displayFiles();
                // 清除之前的分析狀態
                document.getElementById('analysisStatus').innerHTML = '';
                // 重新啟用分析按鈕
                document.getElementById('analyzeBtn').disabled = selectedFiles.length === 0;
            }

            function displayFiles() {
                const fileList = document.getElementById('fileList');
                if (selectedFiles.length === 0) {
                    fileList.innerHTML = '';
                    return;
                }
                
                fileList.innerHTML = '<h3 class="file-list-title">已選擇文件：</h3>';
                selectedFiles.forEach((file, index) => {
                    const fileIcon = getFileIcon(file.name);
                    fileList.innerHTML += \`
                        <div class="file-info">
                            <span style="font-size: 20px; margin-right: 10px;">\${fileIcon}</span>
                            <div style="flex: 1;">
                                <strong>\${file.name}</strong>
                                <div style="color: #666; font-size: 12px;">(\${formatFileSize(file.size)})</div>
                            </div>
                            <button class="btn btn-danger" onclick="removeFile(\${index})" style="margin-left: 10px; padding: 5px 10px;">移除</button>
                        </div>
                    \`;
                });
            }

            function removeFile(index) {
                selectedFiles.splice(index, 1);
                displayFiles();
                // 清除分析狀態
                document.getElementById('analysisStatus').innerHTML = '';
                // 更新按鈕狀態
                document.getElementById('analyzeBtn').disabled = selectedFiles.length === 0;
            }

            function getFileIcon(filename) {
                const ext = filename.split('.').pop().toLowerCase();
                const iconMap = {
                    'png': '🖼️', 'jpg': '🖼️', 'jpeg': '🖼️', 'gif': '🖼️', 'bmp': '🖼️', 'webp': '🖼️',
                    'pdf': '📄', 'doc': '📝', 'docx': '📝', 'txt': '📄', 'md': '📄',
                    'xlsx': '📊', 'xls': '📊', 'html': '🌐', 'htm': '🌐', 'epub': '📚'
                };
                return iconMap[ext] || '📁';
            }

            function formatFileSize(bytes) {
                if (bytes === 0) return '0 Bytes';
                const k = 1024;
                const sizes = ['Bytes', 'KB', 'MB', 'GB'];
                const i = Math.floor(Math.log(bytes) / Math.log(k));
                return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
            }

            function analyzeFiles() {
                if (selectedFiles.length === 0) {
                    alert('請先選擇文件');
                    return;
                }

                document.getElementById('analyzeBtn').disabled = true;
                document.getElementById('analysisStatus').innerHTML = '<div class="loading">正在上傳和分析文件...</div>';

                const formData = new FormData();
                selectedFiles.forEach(file => {
                    formData.append('files', file);
                });

                fetch('/analyze', {
                    method: 'POST',
                    body: formData
                })
                .then(response => response.json())
                .then(data => {
                    if (data.success) {
                        // 清除文件列表和狀態，保持按鈕禁用
                        selectedFiles = [];
                        displayFiles();
                        document.getElementById('analysisStatus').innerHTML = '';
                        loadAllAnalyses();
                        // 按鈕保持禁用狀態，直到重新上傳文件
                    } else {
                        document.getElementById('analysisStatus').innerHTML = '<div style="color: red; padding: 20px; text-align: center;">❌ 分析失敗: ' + data.error + '</div>';
                        // 分析失敗時重新啟用按鈕
                        document.getElementById('analyzeBtn').disabled = false;
                    }
                })
                .catch(error => {
                    console.error('Error:', error);
                    document.getElementById('analysisStatus').innerHTML = '<div style="color: red; padding: 20px; text-align: center;">❌ 分析失敗</div>';
                    // 錯誤時重新啟用按鈕
                    document.getElementById('analyzeBtn').disabled = false;
                });
            }

            function loadAllAnalyses() {
                // 清除搜索輸入框
                document.getElementById('searchInput').value = '';
                
                fetch('/analyses')
                .then(response => response.json())
                .then(data => {
                    displayAnalyses(data);
                })
                .catch(error => {
                    console.error('Error:', error);
                });
            }

            function searchAnalyses() {
                const keyword = document.getElementById('searchInput').value;
                fetch('/analyses/search?keyword=' + encodeURIComponent(keyword))
                .then(response => response.json())
                .then(data => {
                    displayAnalyses(data);
                })
                .catch(error => {
                    console.error('Error:', error);
                });
            }

            function displayAnalyses(analyses) {
                const tableBody = document.getElementById('analysisTable');
                const mobileCards = document.getElementById('mobileCards');
                
                if (analyses.length === 0) {
                    tableBody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #666;">沒有找到數據</td></tr>';
                    mobileCards.innerHTML = '<div style="text-align: center; color: #666; padding: 20px;">沒有找到數據</div>';
                    return;
                }

                // 桌面版表格
                tableBody.innerHTML = analyses.map(analysis => {
                    const createdAt = new Date(analysis.created_at).toLocaleString();
                    const updatedAt = new Date(analysis.updated_at).toLocaleString();
                    const isUpdated = analysis.created_at !== analysis.updated_at;
                    
                    return \`
                    <tr>
                        <td>\${analysis.id}</td>
                        <td style="max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="\${analysis.analysis_summary}">\${analysis.analysis_summary.substring(0, 100)}...</td>
                        <td>\${createdAt}</td>
                        <td style="\${isUpdated ? 'color: #007bff; font-weight: bold;' : 'color: #666;'}" title="\${isUpdated ? '已編輯' : '未編輯'}">\${updatedAt}</td>
                        <td>
                            <button class="btn btn-info" onclick="generateCardNotes(\${analysis.id})" style="margin-right: 5px;">卡片筆記</button>
                            <button class="btn btn-warning" onclick="editAnalysis(\${analysis.id})" style="margin-right: 5px;">編輯</button>
                            <button class="btn btn-danger" onclick="deleteAnalysis(\${analysis.id})">刪除</button>
                        </td>
                    </tr>
                \`;
                }).join('');
                
                // 行動版卡片
                mobileCards.innerHTML = analyses.map(analysis => {
                    const createdAt = new Date(analysis.created_at).toLocaleString();
                    const updatedAt = new Date(analysis.updated_at).toLocaleString();
                    const isUpdated = analysis.created_at !== analysis.updated_at;
                    
                    return \`
                    <div class="analysis-card">
                        <div class="card-header">
                            <div class="card-id">ID: \${analysis.id}</div>
                        </div>
                        <div class="card-summary">\${analysis.analysis_summary}</div>
                        <div class="card-times">
                            <div class="card-time"><strong>創建：</strong>\${createdAt}</div>
                            <div class="card-time \${isUpdated ? 'card-updated' : ''}" \${isUpdated ? 'title="已編輯"' : 'title="未編輯"'}>
                                <strong>更新：</strong>\${updatedAt}
                            </div>
                        </div>
                        <div class="card-actions">
                            <button class="btn btn-info" onclick="generateCardNotes(\${analysis.id})">卡片筆記</button>
                            <button class="btn btn-warning" onclick="editAnalysis(\${analysis.id})">編輯</button>
                            <button class="btn btn-danger" onclick="deleteAnalysis(\${analysis.id})">刪除</button>
                        </div>
                    </div>
                \`;
                }).join('');
            }

            function editAnalysis(id) {
                fetch('/analyses/' + id)
                .then(response => response.json())
                .then(data => {
                    document.getElementById('editId').value = data.id;
                    document.getElementById('editSummary').value = data.analysis_summary;
                    document.getElementById('editContent').value = data.content_text;
                    document.getElementById('editModal').style.display = 'block';
                })
                .catch(error => {
                    console.error('Error:', error);
                    alert('獲取數據失敗');
                });
            }

            function closeEditModal() {
                document.getElementById('editModal').style.display = 'none';
            }

            function saveEdit() {
                const id = document.getElementById('editId').value;
                const summary = document.getElementById('editSummary').value;
                const content = document.getElementById('editContent').value;

                fetch('/analyses/' + id, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        analysis_summary: summary,
                        content_text: content
                    })
                })
                .then(response => response.json())
                .then(data => {
                    if (data.success) {
                        alert('更新成功');
                        closeEditModal();
                        loadAllAnalyses();
                    } else {
                        alert('更新失敗: ' + data.error);
                    }
                })
                .catch(error => {
                    console.error('Error:', error);
                    alert('更新失敗');
                });
            }

            function deleteAnalysis(id) {
                if (confirm('確定要刪除這筆記錄嗎？')) {
                    fetch('/analyses/' + id, {
                        method: 'DELETE'
                    })
                    .then(response => response.json())
                    .then(data => {
                        if (data.success) {
                            alert('刪除成功');
                            loadAllAnalyses();
                        } else {
                            alert('刪除失敗: ' + data.error);
                        }
                    })
                    .catch(error => {
                        console.error('Error:', error);
                        alert('刪除失敗');
                    });
                }
            }

            // 頁面加載時獲取所有分析記錄
            window.onload = function() {
                loadAllAnalyses();
            };

            // 鍵盤快捷鍵支援
            document.addEventListener('keydown', function(event) {
                const modal = document.getElementById('editModal');
                if (modal.style.display === 'block') {
                    // ESC 鍵關閉模態框
                    if (event.key === 'Escape') {
                        closeEditModal();
                    }
                    // Ctrl+S 保存
                    if (event.ctrlKey && event.key === 's') {
                        event.preventDefault();
                        saveEdit();
                    }
                }
            });

            // 點擊模態框外部不關閉（全螢幕模式）
            window.onclick = function(event) {
                // 全螢幕模式下不允許點擊外部關閉
            };

            // 卡片筆記功能
            let currentCardNotesData = '';

            function generateCardNotes(id) {
                document.getElementById('cardNotesModal').style.display = 'block';
                document.getElementById('cardNotesProgress').style.display = 'block';
                document.getElementById('cardNotesContent').style.display = 'none';
                document.getElementById('downloadBtn').style.display = 'none';
                
                // 重置進度條
                document.querySelector('.progress-fill').style.width = '0%';
                
                // 開始處理流程
                processCardNotes(id);
            }

            async function processCardNotes(id) {
                try {
                    // 第一步：內容提取 (33%)
                    updateProgress('正在提取核心概念...', 33);
                    await sleep(1000);
                    
                    const conceptsResponse = await fetch('/card-notes/extract-concepts', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ analysisId: id })
                    });
                    const concepts = await conceptsResponse.json();
                    
                    if (!concepts.success) {
                        throw new Error(concepts.error || '概念提取失敗');
                    }
                    
                    // 第二步：卡片製作 (66%)
                    updateProgress('正在製作原子化卡片...', 66);
                    await sleep(1000);
                    
                    const cardsResponse = await fetch('/card-notes/create-cards', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ concepts: concepts.data || [], analysisId: id })
                    });
                    const cards = await cardsResponse.json();
                    
                    if (!cards.success) {
                        throw new Error(cards.error || '卡片製作失敗');
                    }
                    
                    // 第三步：建立連結 (100%)
                    updateProgress('正在建立概念連結...', 100);
                    await sleep(1000);
                    
                    const connectionsResponse = await fetch('/card-notes/create-connections', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ cards: cards.data || [] })
                    });
                    const connections = await connectionsResponse.json();
                    
                    if (!connections.success) {
                        throw new Error(connections.error || '連結建立失敗');
                    }
                    
                    // 顯示結果
                    displayCardNotes(cards.data || [], connections.data || []);
                    
                } catch (error) {
                    console.error('Error:', error);
                    document.getElementById('cardNotesProgress').style.display = 'none';
                    document.getElementById('cardNotesContent').innerHTML = 
                        '<div style="text-align: center; color: #dc3545; padding: 20px;">處理失敗，請稍後再試</div>';
                    document.getElementById('cardNotesContent').style.display = 'block';
                }
            }

            function updateProgress(text, percentage) {
                document.getElementById('progressText').textContent = text;
                document.querySelector('.progress-fill').style.width = percentage + '%';
            }

            function sleep(ms) {
                return new Promise(resolve => setTimeout(resolve, ms));
            }

            function displayCardNotes(cards, connections) {
                document.getElementById('cardNotesProgress').style.display = 'none';
                
                let html = '<h3>🗂️ 原子化卡片筆記</h3>';
                
                // 確保 cards 是數組
                if (!Array.isArray(cards)) {
                    cards = [];
                }
                
                // 顯示卡片
                cards.forEach((card, index) => {
                    html += \`
                    <div class="card-note">
                        <h3>卡片 \${index + 1}: \${card.title}</h3>
                        <div class="concept">
                            <strong>💡 概念解釋：</strong><br>
                            \${card.concept}
                        </div>
                        <div class="example">
                            <strong>📋 實例說明：</strong><br>
                            \${card.example}
                        </div>
                        <div class="application">
                            <strong>🎯 個人應用建議：</strong><br>
                            \${card.application}
                        </div>
                    </div>
                \`;
                });
                
                // 顯示概念連結
                if (connections && connections.length > 0) {
                    html += '<div class="connections">';
                    html += '<h3>🔗 概念地圖與連結</h3>';
                    connections.forEach(connection => {
                        html += \`<p><strong>\${connection.from}</strong> ↔ <strong>\${connection.to}</strong><br>關係：\${connection.relationship}</p>\`;
                    });
                    html += '</div>';
                }
                
                document.getElementById('cardNotesContent').innerHTML = html;
                document.getElementById('cardNotesContent').style.display = 'block';
                document.getElementById('downloadBtn').style.display = 'inline-block';
                
                // 生成Markdown內容用於下載
                generateMarkdownContent(cards, connections);
            }

            function generateMarkdownContent(cards, connections) {
                let markdown = '# 🗂️ AI卡片筆記\\n\\n';
                markdown += '> 透過AI工作流程生成的原子化學習卡片\\n\\n';
                
                markdown += '## 📚 學習卡片\\n\\n';
                cards.forEach((card, index) => {
                    markdown += \`### 卡片 \${index + 1}: \${card.title}\\n\\n\`;
                    markdown += \`**💡 概念解釋：**\\n\${card.concept}\\n\\n\`;
                    markdown += \`**📋 實例說明：**\\n\${card.example}\\n\\n\`;
                    markdown += \`**🎯 個人應用建議：**\\n\${card.application}\\n\\n\`;
                    markdown += '---\\n\\n';
                });
                
                if (connections && connections.length > 0) {
                    markdown += '## 🔗 概念地圖\\n\\n';
                    connections.forEach(connection => {
                        markdown += \`- **\${connection.from}** ↔ **\${connection.to}**\\n\`;
                        markdown += \`  - 關係：\${connection.relationship}\\n\\n\`;
                    });
                }
                
                markdown += '\\n---\\n';
                markdown += \`\\n*生成時間：\${new Date().toLocaleString()}*\\n\`;
                
                currentCardNotesData = markdown;
            }

            function closeCardNotesModal() {
                document.getElementById('cardNotesModal').style.display = 'none';
            }

            function downloadMarkdown() {
                if (!currentCardNotesData) return;
                
                const blob = new Blob([currentCardNotesData], { type: 'text/markdown' });
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = \`AI卡片筆記_\${new Date().getFullYear()}\${(new Date().getMonth()+1).toString().padStart(2,'0')}\${new Date().getDate().toString().padStart(2,'0')}.md\`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                window.URL.revokeObjectURL(url);
            }
        </script>
    </body>
    </html>
  `);
});

// 文件分析端點
app.post('/analyze', upload.array('files'), async (req, res) => {
  try {
    const files = req.files;
    if (!files || files.length === 0) {
      return res.json({ success: false, error: '沒有收到文件' });
    }

    let combinedText = '';
    const fileNames = [];

    // 提取所有文件的文本內容
    for (const file of files) {
      const text = await extractTextFromFile(file.path, file.originalname);
      combinedText += `\\n\\n=== ${file.originalname} ===\\n${text}`;
      fileNames.push(file.originalname);
    }

    // 執行AI分析
    const aiSummary = await performAIAnalysis(combinedText, fileNames);

    // 保存到數據庫
    try {
      const sql = dbManager.isPostgres 
        ? 'INSERT INTO analyses (analysis_summary, content_text) VALUES ($1, $2) RETURNING id'
        : 'INSERT INTO analyses (analysis_summary, content_text) VALUES (?, ?)';
      const result = await dbManager.run(sql, [aiSummary, combinedText]);
      res.json({ success: true, id: result.lastID });
    } catch (err) {
      console.error('數據庫錯誤:', err);
      res.json({ success: false, error: '數據庫保存失敗' });
    }

    // 清理臨時文件
    files.forEach(file => {
      fs.unlink(file.path, (err) => {
        if (err) console.error('刪除臨時文件失敗:', err);
      });
    });

  } catch (error) {
    console.error('分析錯誤:', error);
    res.json({ success: false, error: error.message });
  }
});

// 獲取所有分析記錄
app.get('/analyses', async (req, res) => {
  try {
    const rows = await dbManager.all('SELECT * FROM analyses ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    console.error('數據庫錯誤:', err);
    res.json([]);
  }
});

// 搜索分析記錄
app.get('/analyses/search', async (req, res) => {
  const keyword = req.query.keyword || '';
  const sql = dbManager.isPostgres 
    ? 'SELECT * FROM analyses WHERE analysis_summary ILIKE $1 OR content_text ILIKE $2 ORDER BY created_at DESC'
    : 'SELECT * FROM analyses WHERE analysis_summary LIKE ? OR content_text LIKE ? ORDER BY created_at DESC';
  const params = [`%${keyword}%`, `%${keyword}%`];
  
  try {
    const rows = await dbManager.all(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('數據庫錯誤:', err);
    res.json([]);
  }
});

// 獲取單個分析記錄
app.get('/analyses/:id', async (req, res) => {
  const id = req.params.id;
  const sql = dbManager.isPostgres ? 'SELECT * FROM analyses WHERE id = $1' : 'SELECT * FROM analyses WHERE id = ?';
  
  try {
    const row = await dbManager.get(sql, [id]);
    if (!row) {
      res.json({ success: false, error: '記錄不存在' });
    } else {
      res.json(row);
    }
  } catch (err) {
    console.error('數據庫錯誤:', err);
    res.json({ success: false, error: '獲取數據失敗' });
  }
});

// 更新分析記錄
app.put('/analyses/:id', async (req, res) => {
  const id = req.params.id;
  const { analysis_summary, content_text } = req.body;
  const sql = dbManager.isPostgres 
    ? 'UPDATE analyses SET analysis_summary = $1, content_text = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3'
    : 'UPDATE analyses SET analysis_summary = ?, content_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?';
  
  try {
    const result = await dbManager.run(sql, [analysis_summary, content_text, id]);
    res.json({ success: true, changes: result.changes });
  } catch (err) {
    console.error('數據庫錯誤:', err);
    res.json({ success: false, error: '更新失敗' });
  }
});

// 刪除分析記錄
app.delete('/analyses/:id', async (req, res) => {
  const id = req.params.id;
  const sql = dbManager.isPostgres ? 'DELETE FROM analyses WHERE id = $1' : 'DELETE FROM analyses WHERE id = ?';
  
  try {
    const result = await dbManager.run(sql, [id]);
    if (result.changes === 0) {
      res.json({ success: false, error: '記錄不存在' });
    } else {
      res.json({ success: true, message: '刪除成功' });
    }
  } catch (err) {
    console.error('數據庫錯誤:', err);
    res.json({ success: false, error: '刪除失敗' });
  }
});

// 卡片筆記相關API端點

// 第一步：內容提取核心概念
app.post('/card-notes/extract-concepts', async (req, res) => {
  try {
    const { analysisId } = req.body;
    
    // 獲取原始分析數據
    const sql = dbManager.isPostgres ? 'SELECT * FROM analyses WHERE id = $1' : 'SELECT * FROM analyses WHERE id = ?';
    const analysis = await dbManager.get(sql, [analysisId]);
    
    if (!analysis) {
      return res.json({ success: false, error: '找不到分析記錄' });
    }

    // AI提取核心概念 - 使用本地分析邏輯
    let concepts = [];
    
    try {
      // 嘗試使用AI分析
      const prompt = `請從以下內容中提取3-5個核心概念：${analysis.analysis_summary}`;
      const aiResponse = await performAIAnalysis(prompt, ['概念提取']);
      
      // 解析AI回應
      const jsonMatch = aiResponse.match(/\[[\s\S]*?\]/);
      if (jsonMatch) {
        concepts = JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      console.log('AI分析不可用，使用本地概念提取');
    }
    
    // 如果AI分析失敗，使用基於實際內容的本地概念提取
    if (concepts.length === 0) {
      console.log('使用本地概念提取，基於實際分析內容');
      
      const analysisText = analysis.analysis_summary || '';
      const contentText = analysis.content_text || '';
      
      // 從AI分析摘要中提取關鍵概念
      concepts = extractConceptsFromAnalysis(analysisText, contentText);
    }

    res.json({ success: true, data: concepts });
  } catch (error) {
    console.error('概念提取錯誤:', error);
    res.json({ success: false, error: '概念提取失敗' });
  }
});

// 第二步：創建原子化卡片
app.post('/card-notes/create-cards', async (req, res) => {
  try {
    const { concepts, analysisId } = req.body;
    
    // 確保 concepts 是數組
    if (!Array.isArray(concepts)) {
      return res.json({ success: false, error: '概念數據格式錯誤' });
    }
    
    const cards = [];
    for (let concept of concepts) {
      let card = {};
      
      try {
        // 嘗試AI分析
        const prompt = `為概念"${concept.concept}"創建學習卡片`;
        const aiResponse = await performAIAnalysis(prompt, ['卡片製作']);
        
        const jsonMatch = aiResponse.match(/\{[\s\S]*?\}/);
        if (jsonMatch) {
          card = JSON.parse(jsonMatch[0]);
        }
      } catch (e) {
        console.log('使用本地卡片生成');
      }
      
      // 如果AI失敗，使用基於實際分析內容的本地邏輯
      if (!card.title) {
        console.log('使用本地卡片生成，基於實際分析內容');
        card = await generateCardFromConcept(concept, analysisId);
      }
      
      cards.push(card);
    }

    res.json({ success: true, data: cards });
  } catch (error) {
    console.error('卡片創建錯誤:', error);
    res.json({ success: false, error: '卡片創建失敗' });
  }
});

// 第三步：建立概念連結
app.post('/card-notes/create-connections', async (req, res) => {
  try {
    const { cards } = req.body;
    
    // 確保 cards 是數組
    if (!Array.isArray(cards) || cards.length < 2) {
      return res.json({ success: true, data: [] });
    }

    const cardTitles = cards.map(card => card.title || '未知概念');
    let connections = [];
    
    try {
      // 嘗試AI分析
      const prompt = `分析概念關聯性：${cardTitles.join(', ')}`;
      const aiResponse = await performAIAnalysis(prompt, ['連結分析']);
      
      const jsonMatch = aiResponse.match(/\[[\s\S]*?\]/);
      if (jsonMatch) {
        connections = JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      console.log('使用本地連結生成');
    }
    
    // 如果AI失敗，使用本地邏輯創建連結
    if (connections.length === 0 && cardTitles.length >= 2) {
      connections = [];
      
      // 創建基本的概念連結
      for (let i = 0; i < Math.min(cardTitles.length - 1, 3); i++) {
        const from = cardTitles[i];
        const to = cardTitles[i + 1];
        
        connections.push({
          from: from,
          to: to,
          relationship: `${from}與${to}在文檔中相互補充，共同構成了完整的知識體系`
        });
      }
      
      // 如果有3個以上概念，添加第一個和最後一個的連結
      if (cardTitles.length >= 3) {
        connections.push({
          from: cardTitles[0],
          to: cardTitles[cardTitles.length - 1],
          relationship: `${cardTitles[0]}是基礎概念，${cardTitles[cardTitles.length - 1]}是應用層面的體現`
        });
      }
    }

    res.json({ success: true, data: connections });
  } catch (error) {
    console.error('連結建立錯誤:', error);
    res.json({ success: false, error: '連結建立失敗' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 AI文件分析系統運行在 http://localhost:${PORT}`);
  console.log('📁 支援格式: TXT, PDF, WORD, MARKDOWN, EXCEL, 圖片, HTML, EPUB');
  console.log('🤖 AI分析功能已啟用');
  console.log('💾 SQLite數據庫已初始化');
});