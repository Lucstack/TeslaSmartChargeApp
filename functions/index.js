// This is the main file for your Cloud Functions.
// It should be located at: /functions/index.js

// Import the necessary Firebase modules using the latest syntax.
const { onSchedule } = require('firebase-functions/v2/scheduler');
// CORRECTED: Import the logger module explicitly for v2 functions.
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

// Import modules for making API requests and parsing XML.
const axios = require('axios');
const xml2js = require('xml2js');

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
    schedule: '10 1 * * *',
    timeZone: 'Europe/Amsterdam',
    region: 'europe-west4', // Set to Netherlands
    secrets: ['ENTSOE_API_KEY'], // Make the secret available to this function
  },
  async event => {
    logger.info('Running fetchEnergyPrices function...');

    // --- Configuration ---
    const REGION_CODE = '10YNL----------L'; // The code for the Netherlands.
    // The API key is now accessed directly from the environment via the 'secrets' option.
    const ENTSOE_API_KEY = process.env.ENTSOE_API_KEY;

    try {
      // --- This section now uses the LIVE API call ---
      const today = new Date();
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const formatDate = date => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}${month}${day}0000`;
      };

      const periodStart = formatDate(today);
      const periodEnd = formatDate(tomorrow);

      // Access the secret API key from the environment.
      const apiUrl = `https://web-api.tp.entsoe.eu/api?securityToken=${ENTSOE_API_KEY}&documentType=A44&in_Domain=${REGION_CODE}&out_Domain=${REGION_CODE}&periodStart=${periodStart}&periodEnd=${periodEnd}`;

      logger.info(`Fetching data from ENTSO-E API...`);
      const response = await axios.get(apiUrl);
      const xmlResponse = response.data;

      // Parse the XML data into a JavaScript object.
      const parser = new xml2js.Parser({ explicitArray: false });
      const parsedData = await parser.parseStringPromise(xmlResponse);

      // Extract the hourly price points from the parsed data.
      const points =
        parsedData.Publication_MarketDocument.TimeSeries.Period.Point;

      const hourlyRates = {};
      points.forEach(point => {
        const hour = parseInt(point.position, 10) - 1;
        const price = parseFloat(point['price.amount']) / 1000;

        hourlyRates[hour] = {
          price: price,
          time: new Date().toISOString(),
        };
      });

      const priceData = {
        lastUpdated: new Date(),
        hourlyRates: hourlyRates,
      };

      await db.collection('energy_prices').doc('NL').set(priceData);

      logger.info('Successfully fetched and saved energy prices for NL.', {
        numberOfRates: Object.keys(hourlyRates).length,
      });
    } catch (error) {
      // Log the full error, including any response data from the API
      if (error.response) {
        logger.error('Error fetching or processing energy prices:', {
          status: error.response.status,
          data: error.response.data,
        });
      } else {
        logger.error('Error fetching or processing energy prices:', error);
      }
    }
  }
);
