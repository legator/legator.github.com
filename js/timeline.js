$(function () {
        $('#career').highcharts({
            chart: {
                type: 'areaspline'
            },
            title: {
                text: 'Career TimeLine'
            },
            legend: {
                layout: 'vertical',
                align: 'right',
                verticalAlign: 'middle',
                borderWidth: 0
            },
            xAxis: {
                categories: [
                    '2007',
                    '2008',
                    'June 2009',
                    'September 2009',
                    'November 2010',
                    'December 2010',
                    '2012',
                    'February 2012',
                    'March 2012',
                    'May 2013',
                    'June 2013',
                    'November 2013'
                ],
                plotBands: [{ // visualize the weekend
                    
                }]
            },
            yAxis: {
                title: {
                    text: ''
                }
            },
            tooltip: {
                formatter: function() {
                    return '<b>'+ this.series.name +'</b><br/>'+ this.x;
                }
            },
            credits: {
                enabled: false
            },
            plotOptions: {
                areaspline: {
                    fillOpacity: 0.5
                }
            },
            series: [{
                name: 'NULP Master degree',
                data: [null, null, null, 5, 5]
            }, {
                name: 'NULP PhD Student',
                data: [null, null, null, null, null, 7, 5, 3, 2, 3, 6, 7]
            }, {
                name: 'NULP Assistant',
                data: [null, null, null, null, null, null, 3, 3, 4, 4]
            }, {
                name: 'Arleons',
                data: [5, 4, 5, 3]
            }, {
                name: 'Produce.in.ua',
                data: [null, 4, 2, 2]
            }, {
                name: 'Silego',
                data: [null, null, null, null, null, null, null, 3, 4]
            }, {
                name: 'LASS_CNRS',
                data: [null, null, null, null, null, null, null, null, null, 7, 6]
            }]
        });
        });