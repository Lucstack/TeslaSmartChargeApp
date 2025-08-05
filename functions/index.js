// This is the main file for your Cloud Functions.
// It should be located at: /functions/index.js

// Import the necessary Firebase modules using the latest syntax.
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

// Import modules for making API requests and parsing XML.
const axios = require("axios");
const xml2js = require("xml2js");

// Initialize the Firebase Admin SDK. This allows our function to interact with Firestore.
admin.initializeApp();
const db = admin.firestore();

/**
 * This Cloud Function runs on a schedule (daily at 1:10 AM) to fetch
 * day-ahead electricity prices from the ENTSO-E API and save them to Firestore.
 * This uses the latest v2 syntax for scheduled functions.
 */
exports.fetchEnergyPrices = onSchedule(
  {
    schedule: "10 1 * * *",
    timeZone: "Europe/Amsterdam",
    region: "europe-west1", // Use a region supported by all services
    secrets: ["ENTSOE_API_KEY"], // Make the secret available to this function
  },
  async (event) => {
    logger.info("Running fetchEnergyPrices function...");

    // --- Configuration ---
    const REGION_CODE = "10YNL----------L"; // The code for the Netherlands.
    const ENTSOE_API_KEY = process.env.ENTSOE_API_KEY;

    try {
        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const formatDate = (date) => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}${month}${day}0000`;
        };
        
        // Correctly format for day-ahead prices (today to tomorrow)
        const periodStart = formatDate(new Date(new Date().setHours(0, 0, 0, 0)));
        const periodEnd = formatDate(new Date(new Date().setDate(new Date().getDate() + 1)));

        const apiUrl = `https://web-api.tp.entsoe.eu/api?securityToken=${ENTSOE_API_KEY}&documentType=A44&in_Domain=${REGION_CODE}&out_Domain=${REGION_CODE}&periodStart=${periodStart}&periodEnd=${periodEnd}`;
        
        logger.info(`Fetching data from ENTSO-E API...`);
        const response = await axios.get(apiUrl);
        const xmlResponse = response.data;
        
        // Parse the XML data into a JavaScript object.
        const parser = new xml2js.Parser({ explicitArray: true }); // Use explicitArray: true for safety
        const parsedData = await parser.parseStringPromise(xmlResponse);
        
        const timeSeries = parsedData.Publication_MarketDocument.TimeSeries;
        if (!timeSeries || timeSeries.length === 0) {
          throw new Error("No TimeSeries data found in the API response.");
        }

        const relevantTimeSeries = timeSeries[timeSeries.length - 1];
        const period = relevantTimeSeries.Period[0];
        const points = period.Point;
        
        if (!points || points.length === 0) {
            throw new Error("No price points found in the relevant TimeSeries.");
        }

        // --- CORRECTED TIMESTAMP LOGIC ---
        // Get the start time for the entire period
        const periodStartTime = new Date(period.timeInterval[0].start[0]);

        const hourlyRates = {};
        points.forEach(point => {
            const hour = parseInt(point.position[0], 10) - 1;
            const price = parseFloat(point['price.amount'][0]) / 1000;
            
            // Calculate the correct timestamp for this specific hour
            const pointTime = new Date(periodStartTime.getTime());
            pointTime.setHours(pointTime.getHours() + hour);

            hourlyRates[hour] = {
                price: price,
                time: pointTime.toISOString(), 
            };
        });

        const priceData = {
            lastUpdated: new Date(),
            hourlyRates: hourlyRates,
        };

        await db.collection("energy_prices").doc("NL").set(priceData);

        logger.info("Successfully fetched and saved energy prices for NL.", {
            numberOfRates: Object.keys(hourlyRates).length,
        });

    } catch (error) {
        if (error.response) {
          logger.error("Error fetching or processing energy prices:", {
            status: error.response.status,
            data: error.response.data,
          });
        } else {
          logger.error("Error fetching or processing energy prices:", error.message);
        }
    }
});

// --- package.json ---
/*
{
  "name": "functions",
  "description": "Cloud Functions for Firebase",
  "scripts": {
    "serve": "firebase emulators:start --only functions",
    "shell": "firebase functions:shell",
    "start": "npm run shell",
    "deploy": "firebase deploy --only functions",
    "logs": "firebase functions:log"
  },
  "engines": {
    "node": "22"
  },
  "main": "index.js",
  "dependencies": {
    "axios": "^1.4.0",
    "firebase-admin": "^11.8.0",
    "firebase-functions": "^5.0.0",
    "xml2js": "^0.6.0"
  },
  "devDependencies": {
    "firebase-functions-test": "^3.1.0"
  },
  "private": true
}
*/
