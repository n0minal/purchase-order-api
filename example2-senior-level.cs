using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Threading.Tasks;
using System.Xml.Linq;
using static System.Net.Mime.MediaTypeNames;

namespace ConsoleAppTest
{
    //Modernize the code using best practices for C#. Feel free to update to .NET 5 or later.
    //Consider things like performance, readability, maintainability, and best practices.
    //api documention can be found here. https://dearinventory.docs.apiary.io/#reference/purchase/purchase-list
    //there are mock endpoints to test against.
    public class Example2
    {
        private const string baseUrl = "https://private-anon-486e6ef696-dearinventory.apiary-mock.com";
        public void GetPurchaseOrdersByDate(DateTime StartDate, string pullStatus, string search, string dateType = "createdSince")
        {
            int page = 1;
            int total = 0;

            do
            {
                string url = $"/ExternalApi/v2/purchaseList?{dateType}={StartDate.ToString("o")}&page={page++}" +
                    $"{(string.IsNullOrEmpty(pullStatus) ? null : "&Status=" + pullStatus)}" +
                    $"{(string.IsNullOrEmpty(search) ? null : "&Search=" + search)}";

                var request = System.Net.WebRequest.CreateHttp(baseUrl + url);
                request.ContentType = "application/json; charset=utf-8";
                request.Method = "GET";
                using var response = (HttpWebResponse)request.GetResponse();
                using var reader = new StreamReader(response.GetResponseStream());
                var result = reader.ReadToEnd();

                if (response.StatusCode == HttpStatusCode.OK)
                {
                    JObject orderobj = JObject.Parse(result);
                    total = (int)orderobj["Total"];
                    JArray orders = (JArray)orderobj["PurchaseList"];
                    foreach (JObject order in orders)
                    {
                        try
                        {
                            string docid = order["ID"]?.ToString();

                            var request2 = System.Net.WebRequest.CreateHttp(baseUrl + "/ExternalApi/v2/purchase?ID=" + docid);
                            request2.ContentType = "application/json; charset=utf-8";
                            request2.Method = "GET";
                            using var response2 = (HttpWebResponse)request2.GetResponse();
                            using var reader2 = new StreamReader(response2.GetResponseStream());
                            var result2 = reader2.ReadToEnd();

                            if (response.StatusCode == HttpStatusCode.OK)
                            {
                                File.WriteAllText("C:\\temp\\purchaseorder_" + docid + ".json", result2);
                            }
                            else
                            {
                                Console.WriteLine("Unable to extract purchase order " + docid);
                            }
                        }
                        catch (Exception e)
                        {
                            Console.WriteLine("Error processing file", e.Message);
                        }
                    }
                }
                else
                {
                    Console.WriteLine("Unable to extract purchase orders ");
                }
            } while ((page - 1) * 100 < total);
        }
    }
}
