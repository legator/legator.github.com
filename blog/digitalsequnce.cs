using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace Matrix
{
    class Program
    {
        static void Main(string[] args)
        {
            int[,] matrix;
            int size;
            int step;

            //get matrix size
            Console.WriteLine("Enter matrix size");
            try
            {
                size = Convert.ToInt32(Console.ReadLine());
            }
            catch (Exception) { size = 0; }

            matrix = new int[size,size];
            decimal d = (Convert.ToDecimal(size) / 2);
            step = Convert.ToInt32(Math.Ceiling(d));
            int start=1;

            //fil matrix cell
            for (int i = 0; i < step; i++)
            {
                matrix[i, i] = start;
                int p = start + 1;
                for (int j = 1; j < size - 2*i - 1; j++)
                {
                    matrix[i, i + j] = p++;
                }
                start = start + (size - 1) - 2 * i;

                matrix[i, size - i - 1] = start;
                p = start + 1;
                for (int j = 1; j < size - 2*i - 1; j++)
                {
                    matrix[i + j, size - i - 1] = p;
                    p++;
                }
                start = start + (size - 1) - 2 * i;

                matrix[size - i - 1, size - i - 1] = start;
                p = start + 1;
                for (int j = 1; j < size - 2*i - 1; j++)
                {
                    matrix[size - i - 1, size - i - 1 - j] = p;
                    p++;
                }
                start = start + (size - 1) - 2 * i;

                matrix[size - i - 1, i] = start;
                p = start + 1;
                for (int j = 1; j < size - 2*i-1; j++)
                {
                    matrix[size - i - 1 - j, i] = p;
                    p++;
                }
                start = p;
            }

            //write matrix to console
            for (int i = 0; i < size; i++)
            {
                for (int j = 0; j < size; j++)
                {
                    Console.Write(matrix[i,j]+" ");
                }
                Console.WriteLine();
            }

            Console.ReadLine();
        }
    }
}
